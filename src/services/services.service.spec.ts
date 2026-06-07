import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { ServicesService } from './services.service';
import { Service } from '../schemas/service.schema';
import { Appointment } from '../schemas/appointment.schema';
import { ServiceCategory } from '../schemas/service.schema';

const mockId = new Types.ObjectId().toHexString();

const makeService = (overrides: Record<string, unknown> = {}) => ({
  _id:          new Types.ObjectId(mockId),
  name:         'Coupe Femme',
  category:     ServiceCategory.HAIRCUT,
  duration:     45,
  price:        45,
  isActive:     true,
  displayOrder: 1,
  save: jest.fn().mockResolvedValue(undefined),
  ...overrides,
});

const makeMockModel = (docOverride?: Record<string, unknown>) => {
  const doc = makeService(docOverride ?? {});
  return {
    findOne:            jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(null) }),
    findById:           jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(doc) }),
    findByIdAndUpdate:  jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(doc) }),
    findByIdAndDelete:  jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(doc) }),
    find:               jest.fn().mockReturnValue({ sort: jest.fn().mockReturnThis(), skip: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue([doc]) }),
    countDocuments:     jest.fn().mockResolvedValue(1),
    aggregate:          jest.fn().mockResolvedValue([]),
    create:             jest.fn().mockResolvedValue(doc),
    _doc:               doc,
  };
};

describe('ServicesService', () => {
  let service: ServicesService;
  let serviceModel: ReturnType<typeof makeMockModel>;
  let apptModel:    ReturnType<typeof makeMockModel>;

  beforeEach(async () => {
    serviceModel = makeMockModel();
    apptModel    = makeMockModel();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ServicesService,
        { provide: getModelToken(Service.name),     useValue: serviceModel },
        { provide: getModelToken(Appointment.name), useValue: apptModel },
      ],
    }).compile();

    service = module.get<ServicesService>(ServicesService);
  });

  /* ── create ── */

  it('creates a service when name is unique', async () => {
    serviceModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
    const result = await service.create({
      name: 'Coupe Femme', category: ServiceCategory.HAIRCUT, duration: 45, price: 45,
    });
    expect(serviceModel.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Coupe Femme' }));
    expect(result).toBeDefined();
  });

  it('throws ConflictException when name already exists', async () => {
    serviceModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(makeService()) });
    await expect(
      service.create({ name: 'Coupe Femme', category: ServiceCategory.HAIRCUT, duration: 45, price: 45 }),
    ).rejects.toThrow(ConflictException);
  });

  /* ── findOne ── */

  it('returns a service by id', async () => {
    const result = await service.findOne(mockId);
    expect(result).toBeDefined();
    expect(serviceModel.findById).toHaveBeenCalledWith(mockId);
  });

  it('throws NotFoundException for unknown id', async () => {
    serviceModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
    await expect(service.findOne(mockId)).rejects.toThrow(NotFoundException);
  });

  it('throws BadRequestException for malformed id', async () => {
    await expect(service.findOne('not-an-object-id')).rejects.toThrow();
  });

  /* ── findAll with category filter ── */

  it('passes category filter to the query', async () => {
    await service.findAll({ category: ServiceCategory.COLORING });
    expect(serviceModel.find).toHaveBeenCalledWith(
      expect.objectContaining({ category: ServiceCategory.COLORING }),
    );
  });

  /* ── toggleActive ── */

  it('toggles isActive from true to false', async () => {
    const doc = makeService({ isActive: true });
    serviceModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(doc) });
    await service.toggleActive(mockId);
    expect(doc.isActive).toBe(false);
    expect(doc.save).toHaveBeenCalled();
  });

  it('toggles isActive from false to true', async () => {
    const doc = makeService({ isActive: false });
    serviceModel.findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(doc) });
    await service.toggleActive(mockId);
    expect(doc.isActive).toBe(true);
    expect(doc.save).toHaveBeenCalled();
  });

  /* ── remove / canDelete ── */

  it('hard-deletes when no appointments reference the service', async () => {
    apptModel.countDocuments.mockResolvedValue(0);
    const result = await service.remove(mockId);
    expect(result).toEqual({ success: true });
    expect(serviceModel.findByIdAndDelete).toHaveBeenCalledWith(mockId);
  });

  it('throws 409 ConflictException when appointments exist', async () => {
    apptModel.countDocuments.mockResolvedValue(3);
    await expect(service.remove(mockId)).rejects.toThrow(ConflictException);
    expect(serviceModel.findByIdAndDelete).not.toHaveBeenCalled();
  });

  /* ── calculateMargin ── */

  it('calculates margin correctly', () => {
    const { margin, marginPercent } = service.calculateMargin(45, 8);
    expect(margin).toBe(37);
    expect(marginPercent).toBe(82);
  });

  it('returns 0 margin when price is 0', () => {
    const { margin, marginPercent } = service.calculateMargin(0, 0);
    expect(margin).toBe(0);
    expect(marginPercent).toBe(0);
  });
});
