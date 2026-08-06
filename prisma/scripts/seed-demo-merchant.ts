/**
 * A demo kitchen with entirely invented customers.
 *
 *   npx tsx prisma/scripts/seed-demo-merchant.ts
 *   npx tsx prisma/scripts/seed-demo-merchant.ts --reset   # wipe and rebuild
 *
 * Why this exists: the marketing site needs real screenshots of the product,
 * and every screen worth showing is full of real customers' names, phone
 * numbers and home addresses. Those cannot go on a public page, and blurring
 * them is both ugly and one slip away from a leak. So the screenshots are taken
 * against a kitchen that does not exist.
 *
 * Every person, phone number and address below is made up. Phone numbers use
 * the +971 55 555 xxxx block and addresses name buildings generically, so
 * nothing here can dial or locate a real person.
 *
 * It doubles as the sample data for onboarding — a merchant who wants to look
 * around before typing in 400 customers of their own.
 */
import bcrypt from 'bcryptjs';
import { prisma } from '../../src/lib/prisma';

const RESET = process.argv.includes('--reset');

const EMAIL = 'demo@tiffinhub.me';
const PASSWORD = 'DemoKitchen123!';

/** Invented. Any resemblance to a real customer is coincidence, not data. */
const CUSTOMERS = [
  ['Aarav Sharma', 'Lunch + Dinner', 3, 'Basmati', 'Veg', 'Marina Heights, Tower 2, Flat 1104', 'Dubai Marina'],
  ['Priya Nair', 'Lunch', 2, 'Basmati', 'Veg', 'Greenview Residence, Flat 802', 'Al Barsha'],
  ['Mohammed Rashid', 'Dinner', 4, 'None', 'Non-Veg', 'Palm Court Building, Flat 205', 'Deira'],
  ['Sneha Iyer', 'Lunch + Dinner', 2, 'Basmati', 'Veg', 'Sunrise Tower A, Flat 1502', 'JLT'],
  ['Rahul Menon', 'Lunch', 3, 'Basmati', 'Both', 'Crystal Plaza, Office 401', 'Business Bay'],
  ['Fatima Ali', 'Dinner', 2, 'None', 'Veg', 'Al Noor Residency, Flat 606', 'Al Qusais'],
  ['Vikram Desai', 'All Meals', 4, 'Basmati', 'Non-Veg', 'Lakeside Tower B, Flat 2210', 'JLT'],
  ['Ananya Reddy', 'Lunch', 2, 'Basmati', 'Jain', 'Emerald Court, Flat 903', 'Al Nahda'],
  ['Karthik Rao', 'Lunch + Dinner', 3, 'None', 'Veg', 'Silver Sands Block C, Flat 118', 'Jumeirah'],
  ['Meera Joshi', 'Dinner', 2, 'Basmati', 'Veg', 'Park View Residence, Flat 704', 'Al Barsha'],
  ['Imran Sheikh', 'Lunch', 3, 'None', 'Non-Veg', 'Corniche Towers, Flat 1806', 'Deira'],
  ['Divya Pillai', 'Lunch + Dinner', 2, 'Basmati', 'Veg', 'Harmony Building, Flat 302', 'Al Qusais'],
  ['Sanjay Gupta', 'Lunch', 4, 'Basmati', 'Both', 'Metro Business Centre, Office 705', 'Business Bay'],
  ['Zainab Khan', 'Dinner', 2, 'None', 'Veg', 'Rose Garden Apartments, Flat 401', 'Al Nahda'],
  ['Arjun Kapoor', 'All Meals', 3, 'Basmati', 'Non-Veg', 'Bay Square Tower 5, Flat 1201', 'Business Bay'],
  ['Lakshmi Venkat', 'Lunch', 2, 'Basmati', 'Jain', 'Sunflower Residency, Flat 505', 'Al Barsha'],
  ['Nikhil Bhat', 'Lunch + Dinner', 3, 'None', 'Veg', 'Ocean Breeze Tower, Flat 1607', 'Dubai Marina'],
  ['Ayesha Siddiqui', 'Dinner', 2, 'Basmati', 'Veg', 'Golden Palm Building, Flat 209', 'Jumeirah'],
  ['Rohan Verma', 'Lunch', 3, 'Basmati', 'Non-Veg', 'Skyline Plaza, Office 302', 'Deira'],
  ['Kavita Menon', 'Lunch + Dinner', 2, 'None', 'Veg', 'Pearl Residence, Flat 1003', 'JLT'],
  ['Tariq Hassan', 'Dinner', 4, 'Basmati', 'Non-Veg', 'Al Waha Tower, Flat 1405', 'Al Qusais'],
  ['Shruti Agarwal', 'Lunch', 2, 'Basmati', 'Premium', 'Cascade Residency, Flat 808', 'Al Barsha'],
  ['Deepak Krishnan', 'Lunch + Dinner', 3, 'Basmati', 'Veg', 'Vista Tower B, Flat 1902', 'Dubai Marina'],
  ['Nadia Farouk', 'Dinner', 2, 'None', 'Veg', 'Amber Court, Flat 604', 'Al Nahda'],
  ['Suresh Babu', 'Lunch', 3, 'Basmati', 'Premium', 'Trade Centre One, Office 1105', 'Business Bay'],
] as const;

const MENU = [
  ['Rajma, Rice, 2 Roti', 'Monday', 'Lunch'],
  ['Chana Masala, Rice, 2 Roti', 'Monday', 'Dinner'],
  ['Mix Veg, Rice, 2 Roti', 'Tuesday', 'Lunch'],
  ['Mix Dal, Rice, 2 Roti', 'Tuesday', 'Dinner'],
  ['Kadhai Paneer, Rice, 2 Roti', 'Wednesday', 'Lunch'],
  ['Kadhi Pakora, Rice, 2 Roti', 'Wednesday', 'Dinner'],
  ['Demo Kitchen Special', 'Thursday', 'Lunch'],
  ['Aloo Gobi, Rice, 2 Roti', 'Thursday', 'Dinner'],
  ['Dal Makhani, Rice, 2 Roti', 'Friday', 'Lunch'],
  ['Bhindi Masala, Rice, 2 Roti', 'Friday', 'Dinner'],
] as const;

async function main() {
  const existing = await prisma.user.findUnique({ where: { email: EMAIL } });

  if (existing && RESET) {
    await prisma.order.deleteMany({ where: { created_by: existing.id } });
    await prisma.customer.deleteMany({ where: { created_by: existing.id } });
    await prisma.menuItem.deleteMany({ where: { created_by: existing.id } });
    await prisma.tiffinAttribute.deleteMany({ where: { created_by: existing.id } });
    console.log('reset: cleared demo data');
  }

  const user = existing
    ? await prisma.user.update({
        where: { email: EMAIL },
        data: { subscription_status: 'active', currency: 'AED', timezone: 'Asia/Dubai' },
      })
    : await prisma.user.create({
        data: {
          email: EMAIL,
          password_hash: await bcrypt.hash(PASSWORD, 10),
          full_name: 'Demo Kitchen',
          business_name: 'Demo Kitchen',
          role: 'user',
          subscription_status: 'active',
          currency: 'AED',
          timezone: 'Asia/Dubai',
        },
      });

  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - 10);
  const end = new Date(today);
  end.setDate(end.getDate() + 20);

  const already = await prisma.customer.count({ where: { created_by: user.id, is_deleted: false } });
  if (already === 0) {
    for (const [name, meal, roti, rice, diet, address, area] of CUSTOMERS) {
      await prisma.customer.create({
        data: {
          full_name: name,
          // +971 55 555 xxxx is not an allocated subscriber range in use here;
          // nothing in this file can dial a real person.
          phone_number: `+97155555${String(1000 + CUSTOMERS.findIndex((c) => c[0] === name)).slice(-4)}`,
          address,
          area,
          meal_type: meal,
          roti_quantity: roti,
          rice_type: rice,
          dietary_preference: diet,
          payment_amount: meal === 'All Meals' ? 900 : meal.includes('+') ? 650 : 400,
          payment_status: 'Paid',
          start_date: start,
          end_date: end,
          paid_days: 30,
          days_remaining: 20,
          active: true,
          created_by: user.id,
        },
      });
    }
    console.log(`seeded ${CUSTOMERS.length} invented customers`);
  } else {
    console.log(`${already} customers already present, left alone`);
  }

  const menuCount = await prisma.menuItem.count({ where: { created_by: user.id } });
  if (menuCount === 0) {
    for (const [name, day, meal] of MENU) {
      await prisma.menuItem.create({
        data: {
          name, item_name: name, day_of_week: day, meal_type: meal,
          diet_type: 'Veg', menu_type: 'set_menu', is_active: true, price: 0,
          created_by: user.id,
        },
      });
    }
    console.log(`seeded ${MENU.length} menu items`);
  }

  console.log(`\nDemo kitchen ready.\n  ${EMAIL}\n  ${PASSWORD}\n`);
  console.log('Now run: npx tsx prisma/scripts/seed-tiffin-attributes.ts --merchant=' + EMAIL);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
