import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AdvancesService } from './advances.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { runWithTenant, TenantContext } from '../common/tenant/tenant-context';

const CTX: TenantContext = {
  tenantId: 'salon-1',
  locationId: 'loc-1',
  locationIds: ['loc-1'],
  role: 'owner',
  plan: 'starter',
  features: {},
  limits: {},
};

function run<T>(fn: () => T): T {
  return runWithTenant(CTX, fn);
}

const OWNER: AuthUser = { sub: 'owner-1', salonId: 'salon-1', role: 'owner', accountType: 'staff', staffId: 'owner-staff-1' };
const STYLIST: AuthUser = { sub: 'user-1', salonId: 'salon-1', role: 'stylist', accountType: 'staff', staffId: 'staff-1' };
const STYLIST_2: AuthUser = { sub: 'user-2', salonId: 'salon-1', role: 'stylist', accountType: 'staff', staffId: 'staff-2' };

describe('AdvancesService', () => {
  let advanceModel: { create: jest.Mock; findOne: jest.Mock; find: jest.Mock };
  let notifications: { dispatch: jest.Mock };
  let staffModel: { findOne: jest.Mock };
  let service: AdvancesService;

  beforeEach(() => {
    advanceModel = { create: jest.fn(), findOne: jest.fn(), find: jest.fn() };
    notifications = { dispatch: jest.fn().mockResolvedValue(undefined) };
    // Par défaut, le staff ciblé "existe" dans ce salon (positive control implicite pour
    // les tests de rôle→status, qui ne portent pas sur cette garde).
    staffModel = { findOne: jest.fn().mockResolvedValue({ _id: 'staff-1' }) };
    service = new AdvancesService(advanceModel as never, staffModel as never, notifications as unknown as NotificationsService);
  });

  describe('create — rôle → status', () => {
    it('owner grants directly → status approved, no pending queue, no notification', async () => {
      advanceModel.create.mockResolvedValue({ _id: 'adv-1', staffId: 'staff-1', status: 'approved' });

      await run(() => service.create(OWNER, { staffId: 'staff-1', amount: 50_000 }));

      expect(advanceModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          staffId: 'staff-1',
          status: 'approved',
          requestedBy: OWNER.sub,
          approvedBy: OWNER.sub,
        }),
      );
      expect(notifications.dispatch).not.toHaveBeenCalled();
    });

    it('owner grant without staffId → BadRequestException, nothing persisted', async () => {
      await expect(run(() => service.create(OWNER, { amount: 50_000 }))).rejects.toThrow(BadRequestException);
      expect(advanceModel.create).not.toHaveBeenCalled();
    });

    it('owner grant targeting a staffId outside this salon → NotFoundException, nothing persisted', async () => {
      staffModel.findOne.mockResolvedValue(null);
      await expect(run(() => service.create(OWNER, { staffId: 'staff-other-salon', amount: 50_000 }))).rejects.toThrow(NotFoundException);
      expect(advanceModel.create).not.toHaveBeenCalled();
    });

    it('staff self-request → status pending, requestedBy = self, emits ADVANCE_REQUESTED to owner', async () => {
      advanceModel.create.mockResolvedValue({ _id: 'adv-2', staffId: 'staff-1', status: 'pending' });

      await run(() => service.create(STYLIST, { amount: 20_000, reason: 'car repair' }));

      expect(advanceModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ staffId: 'staff-1', status: 'pending', requestedBy: 'staff-1' }),
      );
      expect(notifications.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ salonId: 'salon-1', role: 'owner', type: 'advance.requested' }),
      );
    });

    it('staff self-request ignores a client-supplied staffId (cannot request for someone else)', async () => {
      advanceModel.create.mockResolvedValue({ _id: 'adv-3', staffId: 'staff-1', status: 'pending' });

      await run(() => service.create(STYLIST, { staffId: 'staff-2', amount: 10_000 }));

      expect(advanceModel.create).toHaveBeenCalledWith(expect.objectContaining({ staffId: 'staff-1' }));
    });
  });

  describe('decide — idempotence', () => {
    function pendingDoc() {
      return {
        _id: 'adv-1',
        staffId: 'staff-1',
        status: 'pending',
        save: jest.fn().mockResolvedValue(undefined),
      };
    }

    it('approves a pending advance and emits ADVANCE_DECIDED to the staff member', async () => {
      const doc = pendingDoc();
      advanceModel.findOne.mockResolvedValue(doc);

      const result = await run(() => service.decide(OWNER, 'adv-1', { decision: 'approve' }));

      expect(result.status).toBe('approved');
      expect(doc.save).toHaveBeenCalled();
      expect(notifications.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ staffId: 'staff-1', type: 'advance.decided' }),
      );
    });

    it('deciding an already-approved advance throws 409, never re-mutates', async () => {
      const doc = { _id: 'adv-1', staffId: 'staff-1', status: 'approved', save: jest.fn() };
      advanceModel.findOne.mockResolvedValue(doc);

      await expect(run(() => service.decide(OWNER, 'adv-1', { decision: 'approve' }))).rejects.toThrow(ConflictException);
      expect(doc.save).not.toHaveBeenCalled();
      expect(notifications.dispatch).not.toHaveBeenCalled();
    });

    it('deciding an already-settled advance throws 409 (immutable, P6)', async () => {
      const doc = { _id: 'adv-1', staffId: 'staff-1', status: 'settled', save: jest.fn() };
      advanceModel.findOne.mockResolvedValue(doc);

      await expect(run(() => service.decide(OWNER, 'adv-1', { decision: 'reject' }))).rejects.toThrow(ConflictException);
    });
  });

  describe('listForStaff — scope self (#9)', () => {
    it('filters strictly by the caller staffId, never another staff member', async () => {
      const exec = jest.fn().mockResolvedValue([{ _id: 'adv-1', staffId: 'staff-1' }]);
      const sort = jest.fn().mockReturnValue({ exec });
      advanceModel.find.mockReturnValue({ sort });

      const result = await run(() => service.listForStaff(STYLIST));

      expect(advanceModel.find).toHaveBeenCalledWith({ staffId: 'staff-1' });
      expect(result).toHaveLength(1);
    });

    it('returns empty for a caller with no staffId (e.g. malformed token) rather than leaking all', async () => {
      const result = await run(() => service.listForStaff({ ...STYLIST_2, staffId: undefined }));
      expect(result).toEqual([]);
      expect(advanceModel.find).not.toHaveBeenCalled();
    });
  });
});
