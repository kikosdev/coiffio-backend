import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Appointment, AppointmentDocument } from '../booking/schemas/appointment.schema';
import { Schedule, ScheduleDocument } from '../team/schemas/schedule.schema';
import { Sale, SaleDocument } from '../finance/schemas/sale.schema';
import { Payment, PaymentDocument } from '../finance/schemas/payment.schema';
import { Product, ProductDocument } from '../stock/schemas/product.schema';
import { Order, OrderDocument } from '../orders/schemas/order.schema';
import { LeaveRequest, LeaveRequestDocument } from '../team/schemas/leave-request.schema';
import { Staff, StaffDocument } from '../team/schemas/staff.schema';
import { Client, ClientDocument } from '../clients/schemas/client.schema';
import { Service, ServiceDocument } from '../services/schemas/service.schema';
import { addDaysIso, effectiveWindow, todayIso, weekdayOf } from '../booking/availability.util';
import { SalonScope } from '../common/scope/salon-scope';
import { Salon, SalonDocument } from '../seed/schemas/salon.schema';
import { StaffProfile, StaffProfileDocument } from '../team/schemas/staff-profile.schema';
import { computeSalonIsOpen } from '../common/time/salon-clock';

const ACTIVE = ['booked', 'confirmed'];

export interface OverviewResult {
  arc: { hour: number; count: number }[];
  kpis: {
    revenue: number;
    revenueChangePct: number;
    appointments: { booked: number; done: number; noShow: number };
    walkins: number;
    occupancyPct: number;
    tips: number;
    barbersOn: number;
    barbersTotal: number;
  };
  alerts: {
    lowStock: { productId: string; name: string; stock: number; lowStockAt: number }[];
    pendingOrders: number;
    leaveRequests: number;
  };
  topStylists: { stylistId: string; name: string; revenue: number; bookings: number }[];
  todayAppointments: {
    id: string;
    start: Date;
    end: Date;
    clientName: string;
    serviceName: string;
    stylistName: string;
    status: string;
    source: string;
  }[];
  revenueByMethod: { cash: number; card: number; mobile: number };
}

export interface OwnerHqResult {
  id: string;
  name: string;
  address: string;
  hoursToday: string | null;
  isOpen: boolean;
  todayRevenue: number;
  revenueChangePct: number;
  bookingCount: number;
  barbersOn: number;
  barbersTotal: number;
  occupancyPct: number;
  team: { id: string; name: string; initials: string; isPro: boolean; status: 'active' | 'off'; todayCount: number }[];
}

function initials(name: string): string {
  return name.split(' ').map((w) => w[0] ?? '').join('').slice(0, 2).toUpperCase();
}

@Injectable()
export class OverviewService {
  constructor(
    @InjectModel(Appointment.name) private readonly apptModel: Model<AppointmentDocument>,
    @InjectModel(Schedule.name) private readonly scheduleModel: Model<ScheduleDocument>,
    @InjectModel(Sale.name) private readonly saleModel: Model<SaleDocument>,
    @InjectModel(Payment.name) private readonly paymentModel: Model<PaymentDocument>,
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(LeaveRequest.name) private readonly leaveModel: Model<LeaveRequestDocument>,
    @InjectModel(Staff.name) private readonly staffModel: Model<StaffDocument>,
    @InjectModel(Client.name) private readonly clientModel: Model<ClientDocument>,
    @InjectModel(Service.name) private readonly serviceModel: Model<ServiceDocument>,
    @InjectModel(Salon.name) private readonly salonModel: Model<SalonDocument>,
    @InjectModel(StaffProfile.name) private readonly profileModel: Model<StaffProfileDocument>,
  ) {}

  async ownerHq(scope: SalonScope, date = todayIso()): Promise<OwnerHqResult> {
    const [overview, salon, staff, profiles, todayAppts] = await Promise.all([
      this.forDate(scope, date),
      this.salonModel.findById(scope.salonId).lean(),
      this.staffModel.find({ salonId: scope.salonId, isActive: true }).lean(),
      this.profileModel.find({ salonId: scope.salonId }).select('userId level').lean(),
      this.apptModel.find({ salonId: scope.salonId, start: { $gte: new Date(`${date}T00:00:00.000Z`), $lt: new Date(`${addDaysIso(date, 1)}T00:00:00.000Z`) } }).lean(),
    ]);
    if (!salon) {
      return {
        id: scope.salonId,
        name: 'Salon',
        address: '',
        hoursToday: null,
        isOpen: false,
        todayRevenue: overview.kpis.revenue,
        revenueChangePct: overview.kpis.revenueChangePct,
        bookingCount: overview.kpis.appointments.booked + overview.kpis.appointments.done + overview.kpis.appointments.noShow,
        barbersOn: overview.kpis.barbersOn,
        barbersTotal: overview.kpis.barbersTotal,
        occupancyPct: overview.kpis.occupancyPct,
        team: [],
      };
    }

    const todayHours = salon.businessHours?.find((h) => h.day === weekdayOf(date));
    const countByStylist = new Map<string, number>();
    for (const a of todayAppts) {
      if (a.status === 'cancelled' || a.status === 'noshow') continue;
      const id = a.stylistId.toString();
      countByStylist.set(id, (countByStylist.get(id) ?? 0) + 1);
    }
    const profileByStaffId = new Map(profiles.map((profile) => [profile.userId.toString(), profile]));

    return {
      id: salon._id.toString(),
      name: salon.name,
      address: salon.address ?? '',
      hoursToday: todayHours?.isOpen ? `${todayHours.start}-${todayHours.end}` : null,
      isOpen: computeSalonIsOpen(salon) ?? false,
      todayRevenue: overview.kpis.revenue,
      revenueChangePct: overview.kpis.revenueChangePct,
      bookingCount: overview.kpis.appointments.booked + overview.kpis.appointments.done + overview.kpis.appointments.noShow,
      barbersOn: overview.kpis.barbersOn,
      barbersTotal: overview.kpis.barbersTotal,
      occupancyPct: overview.kpis.occupancyPct,
      team: staff.map((s) => {
        const todayCount = countByStylist.get(s._id.toString()) ?? 0;
        return {
          id: s._id.toString(),
          name: s.name,
          initials: initials(s.name),
          isPro: ['master', 'senior'].includes(profileByStaffId.get(s._id.toString())?.level ?? ''),
          status: todayCount > 0 ? 'active' : 'off',
          todayCount,
        };
      }),
    };
  }

  async forDate(scope: SalonScope, date: string): Promise<OverviewResult> {
    const dayStart = new Date(`${date}T00:00:00.000Z`);
    const dayEnd = new Date(`${date}T23:59:59.999Z`);
    const weekday = dayStart.getUTCDay();

    const appts = await this.apptModel.find({
      salonId: scope.salonId,
      start: { $gte: dayStart, $lte: dayEnd },
    });

    // Arc : densité horaire 9–20h.
    const arc = Array.from({ length: 12 }, (_, i) => ({ hour: 9 + i, count: 0 }));
    for (const a of appts) {
      if (a.status === 'cancelled') continue;
      const h = a.start.getUTCHours();
      const slot = arc.find((x) => x.hour === h);
      if (slot) slot.count += 1;
    }

    const booked = appts.filter((a) => ACTIVE.includes(a.status)).length;
    const done = appts.filter((a) => a.status === 'completed').length;
    const noShow = appts.filter((a) => a.status === 'noshow').length;
    const walkins = appts.filter((a) => a.source === 'walkin').length;

    // Occupation : Σ durée RDV / Σ heures de shift dispo (active stylists, ce jour).
    const busyMin = appts
      .filter((a) => a.status !== 'cancelled')
      .reduce((acc, a) => acc + (a.end.getTime() - a.start.getTime()) / 60000, 0);
    // Chair-occupying staff = stylist ∪ colorist (booking.service.ts's convention — colorists
    // are bookable staff too, never exclude them from a "staff on chair" style count).
    const stylists = await this.staffModel.find({ salonId: scope.salonId, role: { $in: ['stylist', 'colorist'] }, isActive: true });
    let availMin = 0;
    let barbersOn = 0;
    for (const st of stylists) {
      const sched = await this.scheduleModel.findOne({ salonId: scope.salonId, stylistId: st._id });
      if (!sched) continue;
      const win = effectiveWindow(sched.weekly, sched.overrides, date);
      if (!win) continue;
      barbersOn += 1;
      const breakMin = win.breaks.reduce((a, b) => a + (b.end - b.start), 0);
      availMin += win.end - win.start - breakMin;
    }
    const occupancyPct = availMin > 0 ? Math.round((busyMin / availMin) * 100) : 0;

    // Revenu + tips.
    const sales = await this.saleModel.find({ salonId: scope.salonId, date: { $gte: dayStart, $lte: dayEnd } });
    const revenue = sales.reduce((a, s) => a + s.total, 0);
    const payments = await this.paymentModel.find({ salonId: scope.salonId, date: { $gte: dayStart, $lte: dayEnd }, refunded: false });
    const tips = payments.reduce((a, p) => a + p.tip, 0);

    // Revenue vs. the prior day, for the HQ "▲X%" chip.
    const prevDayStart = new Date(dayStart.getTime() - 24 * 60 * 60 * 1000);
    const prevDayEnd = new Date(dayEnd.getTime() - 24 * 60 * 60 * 1000);
    const prevSales = await this.saleModel.find({ salonId: scope.salonId, date: { $gte: prevDayStart, $lte: prevDayEnd } });
    const prevRevenue = prevSales.reduce((a, s) => a + s.total, 0);
    const revenueChangePct = prevRevenue === 0 ? (revenue > 0 ? 100 : 0) : Math.round(((revenue - prevRevenue) / prevRevenue) * 100);

    // Alertes.
    const lowStockDocs = await this.productModel
      .find({ salonId: scope.salonId, active: true, $expr: { $lte: ['$stock', '$lowStockAt'] } })
      .sort({ stock: 1 })
      .limit(10);
    const lowStock = lowStockDocs.map((p) => ({ productId: p._id.toString(), name: p.name, stock: p.stock, lowStockAt: p.lowStockAt }));
    const pendingOrders = await this.orderModel.countDocuments({
      salonId: scope.salonId,
      status: { $in: ['pending', 'confirmed', 'ready'] },
    });
    const leaveRequests = await this.leaveModel.countDocuments({ salonId: scope.salonId, status: 'pending' });

    // Top stylists (revenu via Sale.stylistId + bookings du jour).
    const nameOf = new Map(stylists.map((s) => [s._id.toString(), s.name]));
    const revByStylist = new Map<string, number>();
    for (const s of sales) {
      if (!s.stylistId) continue;
      const id = s.stylistId.toString();
      revByStylist.set(id, (revByStylist.get(id) ?? 0) + s.total);
    }
    const bookingsByStylist = new Map<string, number>();
    for (const a of appts) {
      const id = a.stylistId.toString();
      bookingsByStylist.set(id, (bookingsByStylist.get(id) ?? 0) + 1);
    }
    const topStylists = [...new Set([...revByStylist.keys(), ...bookingsByStylist.keys()])]
      .map((stylistId) => ({
        stylistId,
        name: nameOf.get(stylistId) ?? '—',
        revenue: revByStylist.get(stylistId) ?? 0,
        bookings: bookingsByStylist.get(stylistId) ?? 0,
      }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    // Revenue by payment method.
    const revenueByMethod = { cash: 0, card: 0, mobile: 0 };
    for (const p of payments) {
      if (p.method === 'cash') revenueByMethod.cash += p.amount;
      else if (p.method === 'card') revenueByMethod.card += p.amount;
    }

    // Today's appointments with client + service names.
    const activeAppts = appts
      .filter((a) => a.status !== 'cancelled')
      .sort((a, b) => a.start.getTime() - b.start.getTime());

    const uniqueClientIds = [...new Set(activeAppts.map((a) => a.clientId.toString()))];
    const uniqueServiceIds = [...new Set(activeAppts.flatMap((a) => a.services.map((s) => s.toString())))];

    const [clientDocs, serviceDocs] = await Promise.all([
      uniqueClientIds.length > 0
        ? this.clientModel.find({ _id: { $in: uniqueClientIds } }).select('name').lean()
        : Promise.resolve([]),
      uniqueServiceIds.length > 0
        ? this.serviceModel.find({ _id: { $in: uniqueServiceIds } }).select('name').lean()
        : Promise.resolve([]),
    ]);

    const clientNameOf = new Map(clientDocs.map((c) => [(c._id as { toString(): string }).toString(), c.name]));
    const serviceNameOf = new Map(serviceDocs.map((s) => [(s._id as { toString(): string }).toString(), s.name]));

    const todayAppointments = activeAppts.map((a) => ({
      id: a._id.toString(),
      start: a.start,
      end: a.end,
      clientName: clientNameOf.get(a.clientId.toString()) ?? '—',
      serviceName: a.services.length > 0 ? (serviceNameOf.get(a.services[0].toString()) ?? '—') : '—',
      stylistName: nameOf.get(a.stylistId.toString()) ?? '—',
      status: a.status,
      source: a.source,
    }));

    return {
      arc,
      kpis: {
        revenue,
        revenueChangePct,
        appointments: { booked, done, noShow },
        walkins,
        occupancyPct,
        tips,
        barbersOn,
        barbersTotal: stylists.length,
      },
      alerts: { lowStock, pendingOrders, leaveRequests },
      topStylists,
      todayAppointments,
      revenueByMethod,
    };
  }
}
