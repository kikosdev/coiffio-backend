import { NestFactory } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import { AppModule } from './app.module';
import { User, UserDocument, UserRole, StaffJob, LoyaltyTier } from './schemas/user.schema';
import { Stylist, StylistDocument } from './schemas/stylist.schema';
import { Service, ServiceDocument, ServiceCategory } from './schemas/service.schema';
import { Product, ProductDocument } from './schemas/product.schema';
import { Appointment, AppointmentDocument, AppointmentStatus } from './schemas/appointment.schema';
import { Notification, NotificationDocument, NotifType } from './notifications/notification.schema';
import { TeamMember, TeamMemberDocument, MemberLevel, MemberStatus } from './schemas/team-member.schema';
import { LeaveRequest, LeaveRequestDocument, LeaveType, LeaveDecision } from './schemas/leave-request.schema';
import { PayPeriod, PayPeriodDocument, PeriodStatus } from './schemas/pay-period.schema';

async function seed() {
  console.log('Bootstrapping NestJS context…');
  const app = await NestFactory.createApplicationContext(AppModule);

  const userModel    = app.get<Model<UserDocument>>(getModelToken(User.name));
  const stylistModel = app.get<Model<StylistDocument>>(getModelToken(Stylist.name));
  const serviceModel = app.get<Model<ServiceDocument>>(getModelToken(Service.name));
  const productModel = app.get<Model<ProductDocument>>(getModelToken(Product.name));
  const apptModel    = app.get<Model<AppointmentDocument>>(getModelToken(Appointment.name));
  const notifModel   = app.get<Model<NotificationDocument>>(getModelToken(Notification.name));
  const teamModel    = app.get<Model<TeamMemberDocument>>(getModelToken(TeamMember.name));
  const leaveModel   = app.get<Model<LeaveRequestDocument>>(getModelToken(LeaveRequest.name));
  const periodModel  = app.get<Model<PayPeriodDocument>>(getModelToken(PayPeriod.name));

  console.log('Clearing collections…');
  await Promise.all([
    userModel.deleteMany({}),
    stylistModel.deleteMany({}),
    serviceModel.deleteMany({}),
    productModel.deleteMany({}),
    apptModel.deleteMany({}),
    notifModel.deleteMany({}),
    teamModel.deleteMany({}),
    leaveModel.deleteMany({}),
    periodModel.deleteMany({}),
  ]);

  /* ── Passwords ── */
  const [adminHash, staffHash, clientHash] = await Promise.all([
    bcrypt.hash('admin123', 12),
    bcrypt.hash('staff123', 12),
    bcrypt.hash('client123', 12),
  ]);

  /* ── 1. Owner ── */
  const owner = await new userModel({
    firstName: 'Marie', lastName: 'Galland',
    email: 'owner@salon.com', password: adminHash,
    role: UserRole.OWNER, phone: '+33 6 12 34 56 78', isActive: true,
  }).save();

  /* ── 2. Supervisor ── */
  await new userModel({
    firstName: 'Arnaud', lastName: 'Lebrun',
    email: 'supervisor@salon.com', password: adminHash,
    role: UserRole.SUPERVISOR, phone: '+33 6 98 00 11 22', isActive: true,
  }).save();

  /* ── 3. Stylists + staff users ── */
  const stylistLea = await new stylistModel({
    firstName: 'Léa', lastName: 'Bernard',
    role: 'Master Colourist', bio: 'Specialist in balayage and colour techniques.',
    shift: [9, 18], isActive: true,
  }).save();
  const stylistMarcus = await new stylistModel({
    firstName: 'Marcus', lastName: 'Dupont',
    role: "Men's Grooming Lead", bio: 'Expert in precision cuts and beard sculpting.',
    shift: [9, 18], isActive: true,
  }).save();
  const stylistSophie = await new stylistModel({
    firstName: 'Sophie', lastName: 'Martin',
    role: 'Treatment Specialist', bio: 'Passionate about hair health and Olaplex treatments.',
    shift: [9, 18], isActive: true,
  }).save();

  await new userModel({
    firstName: 'Léa', lastName: 'Bernard',
    email: 'lea@salon.com', password: staffHash,
    role: UserRole.STAFF, job: StaffJob.COLORIST,
    staffId: stylistLea._id, phone: '+33 6 11 22 33 44', isActive: true,
  }).save();
  await new userModel({
    firstName: 'Marcus', lastName: 'Dupont',
    email: 'marcus@salon.com', password: staffHash,
    role: UserRole.STAFF, job: StaffJob.STYLIST,
    staffId: stylistMarcus._id, phone: '+33 6 55 66 77 88', isActive: true,
  }).save();
  const staffSophie = await new userModel({
    firstName: 'Sophie', lastName: 'Martin',
    email: 'sophie@salon.com', password: staffHash,
    role: UserRole.STAFF, job: StaffJob.ASSISTANT,
    staffId: stylistSophie._id, phone: '+33 6 99 00 11 22', isActive: true,
  }).save();

  /* ── 4. Clients ── */
  const client1 = await new userModel({
    firstName: 'Alice', lastName: 'Dubois',
    email: 'client@salon.com', password: clientHash,
    role: UserRole.CLIENT, loyaltyTier: LoyaltyTier.MAISON,
    loyaltyPoints: 240, totalVisits: 8, totalSpent: 520,
  }).save();
  const client2 = await new userModel({
    firstName: 'Béatrice', lastName: 'Morel',
    email: 'beatrice@salon.com', password: clientHash,
    role: UserRole.CLIENT, loyaltyTier: LoyaltyTier.INITIEE, loyaltyPoints: 85,
  }).save();
  const client3 = await new userModel({
    firstName: 'Catherine', lastName: 'Petit',
    email: 'catherine@salon.com', password: clientHash,
    role: UserRole.CLIENT, loyaltyTier: LoyaltyTier.INITIEE, loyaltyPoints: 60,
  }).save();
  const client4 = await new userModel({
    firstName: 'Damien', lastName: 'Vasseur',
    email: 'damien@salon.com', password: clientHash,
    role: UserRole.CLIENT, loyaltyTier: LoyaltyTier.INITIEE, loyaltyPoints: 130,
  }).save();
  const client5 = await new userModel({
    firstName: 'Élodie', lastName: 'Roussel',
    email: 'elodie@salon.com', password: clientHash,
    role: UserRole.CLIENT, loyaltyTier: LoyaltyTier.MAITRE,
    loyaltyPoints: 890, totalVisits: 24, totalSpent: 3200,
  }).save();

  /* ── 5. Services ── */
  const svcCoupeFemme   = await new serviceModel({ name: 'Coupe Femme',           category: ServiceCategory.HAIRCUT,   duration: 45,  price: 45,  costPrice: 8,  displayOrder: 1,  color: '#B89968' }).save();
  const svcCoupeHomme   = await new serviceModel({ name: 'Coupe Homme',           category: ServiceCategory.HAIRCUT,   duration: 30,  price: 28,  costPrice: 5,  displayOrder: 2,  color: '#B89968' }).save();
  const svcCoupeEnfant  = await new serviceModel({ name: 'Coupe Enfant',          category: ServiceCategory.HAIRCUT,   duration: 20,  price: 18,  costPrice: 4,  displayOrder: 3,  color: '#B89968' }).save();
  const svcCouleurRac   = await new serviceModel({ name: 'Couleur Racines',       category: ServiceCategory.COLORING,  duration: 60,  price: 55,  costPrice: 18, displayOrder: 4,  color: '#8B6914' }).save();
  const svcBalayage     = await new serviceModel({ name: 'Balayage',              category: ServiceCategory.COLORING,  duration: 120, price: 95,  costPrice: 28, displayOrder: 5,  color: '#8B6914' }).save();
  const svcMeches       = await new serviceModel({ name: 'Mèches',                category: ServiceCategory.COLORING,  duration: 90,  price: 75,  costPrice: 22, displayOrder: 6,  color: '#8B6914' }).save();
  const svcPatine       = await new serviceModel({ name: 'Patine',                category: ServiceCategory.COLORING,  duration: 45,  price: 35,  costPrice: 10, displayOrder: 7,  color: '#8B6914' }).save();
  const svcSoinProfond  = await new serviceModel({ name: 'Soin Profond',          category: ServiceCategory.TREATMENT, duration: 30,  price: 25,  costPrice: 6,  displayOrder: 8,  color: '#4A7C59' }).save();
  const svcBotox        = await new serviceModel({ name: 'Botox Capillaire',      category: ServiceCategory.TREATMENT, duration: 60,  price: 65,  costPrice: 20, displayOrder: 9,  color: '#4A7C59' }).save();
  const svcBrushing     = await new serviceModel({ name: 'Brushing',              category: ServiceCategory.STYLING,   duration: 30,  price: 22,  costPrice: 4,  displayOrder: 10, color: '#6B5B95' }).save();
  const svcCoiffEvent   = await new serviceModel({ name: 'Coiffure Événement',   category: ServiceCategory.STYLING,   duration: 60,  price: 55,  costPrice: 10, displayOrder: 11, color: '#6B5B95' }).save();
  const svcBarbe        = await new serviceModel({ name: 'Taille de Barbe',       category: ServiceCategory.BEARD,     duration: 20,  price: 15,  costPrice: 3,  displayOrder: 12, color: '#2F4F6F' }).save();

  /* ── 6. Products ── */
  await new productModel({ name: 'Absolut Repair Shampoo',      description: 'Deep repair for damaged hair.',      category: 'Shampoo',     priceEur: 28, stockQuantity: 15 }).save();
  await new productModel({ name: 'Absolut Repair Conditioner',  description: 'Strengthening conditioner.',         category: 'Conditioner', priceEur: 32, stockQuantity: 12 }).save();
  await new productModel({ name: 'Metal Detox Cream',           description: 'Anti-metal cleansing cream.',        category: 'Treatment',   priceEur: 36, stockQuantity: 3  }).save();
  await new productModel({ name: 'Mythic Oil Original',         description: 'Nourishing shine oil.',              category: 'Styling',     priceEur: 38, stockQuantity: 8  }).save();
  await new productModel({ name: 'Savage Panache Hairspray',    description: 'Volumising texture spray.',          category: 'Styling',     priceEur: 24, stockQuantity: 2  }).save();
  await new productModel({ name: 'Pro Longer Renewing Cream',   description: 'Length-renewing leave-in cream.',    category: 'Treatment',   priceEur: 29, stockQuantity: 10 }).save();
  await new productModel({ name: 'Silver Shampoo',              description: 'Toning shampoo for blonde/grey.',   category: 'Shampoo',     priceEur: 26, stockQuantity: 14 }).save();
  await new productModel({ name: 'Steampod Serum',              description: 'Heat-activated smoothing serum.',   category: 'Styling',     priceEur: 42, stockQuantity: 7  }).save();
  await new productModel({ name: 'Chronologiste Mask',          description: 'Premium revitalising mask.',         category: 'Treatment',   priceEur: 68, stockQuantity: 6  }).save();
  await new productModel({ name: "Elixir Ultime L'Huile",       description: 'Luxurious multi-benefit oil.',       category: 'Styling',     priceEur: 54, stockQuantity: 9  }).save();

  /* ── 7. Appointments ── */
  const d = (offset: number, h: number, m = 0) => {
    const dt = new Date(); dt.setDate(dt.getDate() + offset); dt.setHours(h, m, 0, 0); return dt;
  };

  const appt1 = await new apptModel({ clientId: client1._id, stylistId: stylistLea._id,    serviceIds: [svcBalayage._id],    startsAt: d(-3, 10),    endsAt: d(-3, 12),     totalDurationMinutes: 120, totalPriceEur: 95,  status: AppointmentStatus.COMPLETED, referenceCode: 'HRE-A00001' }).save();
  await new apptModel({ clientId: client2._id, stylistId: stylistMarcus._id, serviceIds: [svcCoupeFemme._id],  startsAt: d(-2, 14),    endsAt: d(-2, 14, 45), totalDurationMinutes: 45,  totalPriceEur: 45,  status: AppointmentStatus.COMPLETED, referenceCode: 'HRE-A00002' }).save();
  await new apptModel({ clientId: client3._id, stylistId: stylistSophie._id, serviceIds: [svcSoinProfond._id], startsAt: d(-1, 11),    endsAt: d(-1, 11, 30), totalDurationMinutes: 30,  totalPriceEur: 25,  status: AppointmentStatus.COMPLETED, referenceCode: 'HRE-A00003' }).save();
  await new apptModel({ clientId: client4._id, stylistId: stylistMarcus._id, serviceIds: [svcBarbe._id],       startsAt: d(0, 11, 30), endsAt: d(0, 11, 50),  totalDurationMinutes: 20,  totalPriceEur: 15,  status: AppointmentStatus.CONFIRMED,  referenceCode: 'HRE-A00004' }).save();
  const appt5 = await new apptModel({ clientId: client1._id, stylistId: stylistLea._id,    serviceIds: [svcCouleurRac._id],  startsAt: d(0, 13),     endsAt: d(0, 14),      totalDurationMinutes: 60,  totalPriceEur: 55,  status: AppointmentStatus.IN_PROGRESS, referenceCode: 'HRE-A00005' }).save();
  const appt6 = await new apptModel({ clientId: client5._id, stylistId: stylistSophie._id, serviceIds: [svcBotox._id],       startsAt: d(0, 15, 30), endsAt: d(0, 16, 30),  totalDurationMinutes: 60,  totalPriceEur: 65,  status: AppointmentStatus.CONFIRMED,  referenceCode: 'HRE-A00006' }).save();
  await new apptModel({ clientId: client2._id, stylistId: stylistMarcus._id, serviceIds: [svcBarbe._id],       startsAt: d(1, 10),     endsAt: d(1, 10, 20),  totalDurationMinutes: 20,  totalPriceEur: 15,  status: AppointmentStatus.CONFIRMED,  referenceCode: 'HRE-A00007' }).save();
  const appt8 = await new apptModel({ clientId: client3._id, stylistId: stylistLea._id,    serviceIds: [svcBrushing._id],    startsAt: d(1, 14),     endsAt: d(1, 14, 30),  totalDurationMinutes: 30,  totalPriceEur: 22,  status: AppointmentStatus.PENDING,    referenceCode: 'HRE-A00008' }).save();
  await new apptModel({ clientId: client4._id, stylistId: stylistSophie._id, serviceIds: [svcSoinProfond._id], startsAt: d(2, 11),     endsAt: d(2, 11, 30),  totalDurationMinutes: 30,  totalPriceEur: 25,  status: AppointmentStatus.CONFIRMED,  referenceCode: 'HRE-A00009' }).save();
  await new apptModel({ clientId: client5._id, stylistId: stylistLea._id,    serviceIds: [svcBalayage._id],    startsAt: d(3, 9, 30),  endsAt: d(3, 11, 30),  totalDurationMinutes: 120, totalPriceEur: 95,  status: AppointmentStatus.PENDING,    referenceCode: 'HRE-A00010' }).save();

  /* ── 8. Demo notifications ── */
  await Promise.all([
    new notifModel({ userId: owner._id,      type: NotifType.LOW_STOCK,             title: 'Low stock alert',             body: 'Metal Detox Cream is running low (3 units remaining).',                                                 isRead: false }).save(),
    new notifModel({ userId: owner._id,      type: NotifType.LOW_STOCK,             title: 'Low stock alert',             body: 'Savage Panache Hairspray is running low (2 units remaining).',                                          isRead: false }).save(),
    new notifModel({ userId: owner._id,      type: NotifType.PAYMENT_RECORDED,      title: 'Payment recorded',            body: `€240 received for appointment ${appt1.referenceCode}.`,            data: { appointmentId: appt1._id?.toString() }, isRead: false }).save(),
    new notifModel({ userId: client1._id,    type: NotifType.APPOINTMENT_CONFIRMED, title: 'Appointment confirmed',       body: `Your appointment ${appt5.referenceCode} is confirmed for today.`,  data: { appointmentId: appt5._id?.toString() }, isRead: false }).save(),
    new notifModel({ userId: client1._id,    type: NotifType.APPOINTMENT_REMINDER,  title: 'Reminder — visit tomorrow',  body: 'Your appointment with Léa is scheduled for tomorrow at 14:00.',    data: { appointmentId: appt8._id?.toString() }, isRead: false }).save(),
    new notifModel({ userId: staffSophie._id, type: NotifType.APPOINTMENT_CREATED,  title: 'New appointment assigned',   body: `Client ${client5.firstName} booked a Scalp Spa at 15:30.`,         data: { appointmentId: appt6._id?.toString() }, isRead: false }).save(),
  ]);

  /* ── 9. Team (Équipe : rota · congés · paie) ── */
  await teamModel.insertMany([
    {
      name: 'Léa Dubois', role: 'Master Colourist', dept: 'Colour', initials: 'L', tone: 'ph-3',
      level: MemberLevel.MASTER, status: MemberStatus.SHIFT, since: 2019,
      util: 92, rebook: 78, ticket: 161, retail: 18,
      base: 2400, commission: 920, tip: 312, period: 3632,
      week: [[9, 18], [9, 18], null, [9, 18], [9, 19], 'leave', null],
    },
    {
      name: 'Marcus Voss', role: "Men's Grooming Lead", dept: 'Grooming', initials: 'M', tone: 'ph-7',
      level: MemberLevel.SENIOR, status: MemberStatus.SHIFT, since: 2021,
      util: 84, rebook: 71, ticket: 58, retail: 12,
      base: 2100, commission: 640, tip: 268, period: 3008,
      week: [[9, 17], [9, 17], [9, 17], null, [9, 17], [10, 18], null],
    },
    {
      name: 'Théo Roux', role: 'Cuts · Styling', dept: 'Styling', initials: 'T', tone: 'ph-2',
      level: MemberLevel.SENIOR, status: MemberStatus.BREAK, since: 2022,
      util: 78, rebook: 66, ticket: 96, retail: 8,
      base: 1950, commission: 510, tip: 214, period: 2674,
      week: [[11, 20], [11, 20], [11, 20], [11, 20], null, [11, 20], null],
    },
    {
      name: 'Nadia Hassan', role: 'Treatments · Spa', dept: 'Spa', initials: 'N', tone: 'ph-5',
      level: MemberLevel.SENIOR, status: MemberStatus.SHIFT, since: 2020,
      util: 88, rebook: 74, ticket: 132, retail: 22,
      base: 2050, commission: 580, tip: 196, period: 2826,
      week: [[9, 16], [9, 16], null, [9, 16], [9, 16], [9, 14], null],
    },
    {
      name: 'Inès Caron', role: 'Junior Stylist', dept: 'Styling', initials: 'I', tone: 'ph-4',
      level: MemberLevel.JUNIOR, status: MemberStatus.OFF, since: 2024,
      util: 61, rebook: 52, ticket: 44, retail: 5,
      base: 1500, commission: 210, tip: 88, period: 1798,
      week: [null, [12, 19], [12, 19], [12, 19], [12, 19], [12, 19], null],
    },
  ]);

  await leaveModel.insertMany([
    { who: 'Léa Dubois',   init: 'L', type: LeaveType.ANNUAL,     range: '12–16 May', days: 5, sub: 'Family trip · covered by Nadia',  decided: LeaveDecision.PENDING },
    { who: 'Théo Roux',    init: 'T', type: LeaveType.SWAP,       range: 'Sat 24 May', days: 1, sub: 'Swap with Marcus (morning)',     decided: LeaveDecision.PENDING },
    { who: 'Inès Caron',   init: 'I', type: LeaveType.LATE_START, range: 'Wed 21 May', days: 0, sub: 'Medical appointment · +2h',     decided: LeaveDecision.PENDING },
    { who: 'Nadia Hassan', init: 'N', type: LeaveType.ANNUAL,     range: '2–4 Jun',   days: 3, sub: 'Approved last week',             decided: LeaveDecision.APPROVED },
  ]);

  await periodModel.insertMany([
    { label: 'May 2026',   range: '1–31 May',  mult: 1,    status: PeriodStatus.CURRENT },
    { label: 'April 2026', range: '1–30 Apr',  mult: 0.94, status: PeriodStatus.PAID },
    { label: 'March 2026', range: '1–31 Mar',  mult: 1.08, status: PeriodStatus.PAID },
    { label: 'Feb 2026',   range: '1–28 Feb',  mult: 0.88, status: PeriodStatus.PAID },
  ]);

  const [uCount, sCount, svCount, pCount, aCount, nCount, tCount] = await Promise.all([
    userModel.countDocuments(), stylistModel.countDocuments(), serviceModel.countDocuments(),
    productModel.countDocuments(), apptModel.countDocuments(), notifModel.countDocuments(),
    teamModel.countDocuments(),
  ]);

  console.log('\n✅ Seed complete.');
  console.log('  owner@salon.com       / admin123   (owner)');
  console.log('  supervisor@salon.com  / admin123   (supervisor)');
  console.log('  lea@salon.com         / staff123   (staff – colorist)');
  console.log('  marcus@salon.com      / staff123   (staff – stylist)');
  console.log('  sophie@salon.com      / staff123   (staff – assistant)');
  console.log('  client@salon.com      / client123  (client)');
  console.log(`\n  ${uCount} users · ${sCount} stylists · ${svCount} services · ${pCount} products · ${aCount} appointments · ${nCount} notifications · ${tCount} team members\n`);

  await app.close();
}

seed().catch(e => { console.error(e); process.exit(1); });
