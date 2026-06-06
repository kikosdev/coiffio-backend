import { NestFactory } from '@nestjs/core';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import { AppModule } from './app.module';
import { User, UserDocument, UserRole, StaffJob, LoyaltyTier } from './schemas/user.schema';
import { Stylist, StylistDocument } from './schemas/stylist.schema';
import { Service, ServiceDocument, ServiceCategory, ServiceAudience } from './schemas/service.schema';
import { Product, ProductDocument } from './schemas/product.schema';
import { Appointment, AppointmentDocument, AppointmentStatus } from './schemas/appointment.schema';
import { Notification, NotificationDocument, NotifType } from './notifications/notification.schema';

async function seed() {
  console.log('Bootstrapping NestJS context…');
  const app = await NestFactory.createApplicationContext(AppModule);

  const userModel    = app.get<Model<UserDocument>>(getModelToken(User.name));
  const stylistModel = app.get<Model<StylistDocument>>(getModelToken(Stylist.name));
  const serviceModel = app.get<Model<ServiceDocument>>(getModelToken(Service.name));
  const productModel = app.get<Model<ProductDocument>>(getModelToken(Product.name));
  const apptModel    = app.get<Model<AppointmentDocument>>(getModelToken(Appointment.name));
  const notifModel   = app.get<Model<NotificationDocument>>(getModelToken(Notification.name));

  console.log('Clearing collections…');
  await Promise.all([
    userModel.deleteMany({}),
    stylistModel.deleteMany({}),
    serviceModel.deleteMany({}),
    productModel.deleteMany({}),
    apptModel.deleteMany({}),
    notifModel.deleteMany({}),
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
  const svcCoupe    = await new serviceModel({ name: 'Coupe Éditoriale',       description: 'Precision cut tailored to your face shape and hair texture.', category: ServiceCategory.CUTS,       audience: ServiceAudience.ALL,   durationMinutes: 60,  priceEur: 65  }).save();
  const svcBrush    = await new serviceModel({ name: 'Blowout & Finish',        description: 'Professional blowout with styling and finishing products.',    category: ServiceCategory.STYLING,    audience: ServiceAudience.ALL,   durationMinutes: 45,  priceEur: 55  }).save();
  const svcBalayage = await new serviceModel({ name: 'Balayage Couture',        description: 'Hand-painted balayage for sun-kissed, dimensional colour.',    category: ServiceCategory.COLOUR,     audience: ServiceAudience.WOMEN, durationMinutes: 150, priceEur: 240 }).save();
  const svcColour   = await new serviceModel({ name: 'Colour & Highlights',     description: 'Full colour service with foil highlights.',                    category: ServiceCategory.COLOUR,     audience: ServiceAudience.WOMEN, durationMinutes: 120, priceEur: 160 }).save();
  const svcOlaplex  = await new serviceModel({ name: 'Olaplex Bond Treatment',  description: 'Intensive bond repair treatment for damaged hair.',             category: ServiceCategory.TREATMENTS, audience: ServiceAudience.ALL,   durationMinutes: 45,  priceEur: 95  }).save();
  const svcScalp    = await new serviceModel({ name: 'Scalp Spa',               description: 'Purifying scalp treatment with massage and hydration mask.',    category: ServiceCategory.TREATMENTS, audience: ServiceAudience.ALL,   durationMinutes: 60,  priceEur: 110 }).save();
  const svcCut      = await new serviceModel({ name: 'Signature Cut',           description: 'Classic cut with wash and blow-dry.',                          category: ServiceCategory.CUTS,       audience: ServiceAudience.ALL,   durationMinutes: 60,  priceEur: 78  }).save();
  const svcBeard    = await new serviceModel({ name: 'Beard Sculpt',            description: 'Precision beard shaping and grooming.',                        category: ServiceCategory.GROOMING,   audience: ServiceAudience.MEN,   durationMinutes: 45,  priceEur: 75  }).save();

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

  const appt1 = await new apptModel({ clientId: client1._id, stylistId: stylistLea._id,    serviceIds: [svcBalayage._id], startsAt: d(-3, 10),    endsAt: d(-3, 12, 30), totalDurationMinutes: 150, totalPriceEur: 240, status: AppointmentStatus.COMPLETED, referenceCode: 'HRE-A00001' }).save();
  await new apptModel({ clientId: client2._id, stylistId: stylistMarcus._id, serviceIds: [svcCut._id],     startsAt: d(-2, 14),    endsAt: d(-2, 15),     totalDurationMinutes: 60,  totalPriceEur: 78,  status: AppointmentStatus.COMPLETED, referenceCode: 'HRE-A00002' }).save();
  await new apptModel({ clientId: client3._id, stylistId: stylistSophie._id, serviceIds: [svcOlaplex._id], startsAt: d(-1, 11),    endsAt: d(-1, 11, 45), totalDurationMinutes: 45,  totalPriceEur: 95,  status: AppointmentStatus.COMPLETED, referenceCode: 'HRE-A00003' }).save();
  await new apptModel({ clientId: client4._id, stylistId: stylistMarcus._id, serviceIds: [svcBeard._id],   startsAt: d(0, 11, 30), endsAt: d(0, 12, 15),  totalDurationMinutes: 45,  totalPriceEur: 75,  status: AppointmentStatus.CONFIRMED,  referenceCode: 'HRE-A00004' }).save();
  const appt5 = await new apptModel({ clientId: client1._id, stylistId: stylistLea._id,    serviceIds: [svcColour._id],   startsAt: d(0, 13),     endsAt: d(0, 15),      totalDurationMinutes: 120, totalPriceEur: 160, status: AppointmentStatus.IN_PROGRESS, referenceCode: 'HRE-A00005' }).save();
  const appt6 = await new apptModel({ clientId: client5._id, stylistId: stylistSophie._id, serviceIds: [svcScalp._id],    startsAt: d(0, 15, 30), endsAt: d(0, 16, 30),  totalDurationMinutes: 60,  totalPriceEur: 110, status: AppointmentStatus.CONFIRMED,  referenceCode: 'HRE-A00006' }).save();
  await new apptModel({ clientId: client2._id, stylistId: stylistMarcus._id, serviceIds: [svcBeard._id],   startsAt: d(1, 10),     endsAt: d(1, 10, 45),  totalDurationMinutes: 45,  totalPriceEur: 75,  status: AppointmentStatus.CONFIRMED,  referenceCode: 'HRE-A00007' }).save();
  const appt8 = await new apptModel({ clientId: client3._id, stylistId: stylistLea._id,    serviceIds: [svcBrush._id],    startsAt: d(1, 14),     endsAt: d(1, 14, 45),  totalDurationMinutes: 45,  totalPriceEur: 55,  status: AppointmentStatus.PENDING,    referenceCode: 'HRE-A00008' }).save();
  await new apptModel({ clientId: client4._id, stylistId: stylistSophie._id, serviceIds: [svcOlaplex._id], startsAt: d(2, 11),     endsAt: d(2, 11, 45),  totalDurationMinutes: 45,  totalPriceEur: 95,  status: AppointmentStatus.CONFIRMED,  referenceCode: 'HRE-A00009' }).save();
  await new apptModel({ clientId: client5._id, stylistId: stylistLea._id,    serviceIds: [svcBalayage._id], startsAt: d(3, 9, 30),  endsAt: d(3, 12),      totalDurationMinutes: 150, totalPriceEur: 240, status: AppointmentStatus.PENDING,    referenceCode: 'HRE-A00010' }).save();

  /* ── 8. Demo notifications ── */
  await Promise.all([
    new notifModel({ userId: owner._id,      type: NotifType.LOW_STOCK,             title: 'Low stock alert',             body: 'Metal Detox Cream is running low (3 units remaining).',                                                 isRead: false }).save(),
    new notifModel({ userId: owner._id,      type: NotifType.LOW_STOCK,             title: 'Low stock alert',             body: 'Savage Panache Hairspray is running low (2 units remaining).',                                          isRead: false }).save(),
    new notifModel({ userId: owner._id,      type: NotifType.PAYMENT_RECORDED,      title: 'Payment recorded',            body: `€240 received for appointment ${appt1.referenceCode}.`,            data: { appointmentId: appt1._id?.toString() }, isRead: false }).save(),
    new notifModel({ userId: client1._id,    type: NotifType.APPOINTMENT_CONFIRMED, title: 'Appointment confirmed',       body: `Your appointment ${appt5.referenceCode} is confirmed for today.`,  data: { appointmentId: appt5._id?.toString() }, isRead: false }).save(),
    new notifModel({ userId: client1._id,    type: NotifType.APPOINTMENT_REMINDER,  title: 'Reminder — visit tomorrow',  body: 'Your appointment with Léa is scheduled for tomorrow at 14:00.',    data: { appointmentId: appt8._id?.toString() }, isRead: false }).save(),
    new notifModel({ userId: staffSophie._id, type: NotifType.APPOINTMENT_CREATED,  title: 'New appointment assigned',   body: `Client ${client5.firstName} booked a Scalp Spa at 15:30.`,         data: { appointmentId: appt6._id?.toString() }, isRead: false }).save(),
  ]);

  const [uCount, sCount, svCount, pCount, aCount, nCount] = await Promise.all([
    userModel.countDocuments(), stylistModel.countDocuments(), serviceModel.countDocuments(),
    productModel.countDocuments(), apptModel.countDocuments(), notifModel.countDocuments(),
  ]);

  console.log('\n✅ Seed complete.');
  console.log('  owner@salon.com       / admin123   (owner)');
  console.log('  supervisor@salon.com  / admin123   (supervisor)');
  console.log('  lea@salon.com         / staff123   (staff – colorist)');
  console.log('  marcus@salon.com      / staff123   (staff – stylist)');
  console.log('  sophie@salon.com      / staff123   (staff – assistant)');
  console.log('  client@salon.com      / client123  (client)');
  console.log(`\n  ${uCount} users · ${sCount} stylists · ${svCount} services · ${pCount} products · ${aCount} appointments · ${nCount} notifications\n`);

  await app.close();
}

seed().catch(e => { console.error(e); process.exit(1); });
