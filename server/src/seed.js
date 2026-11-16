import bcrypt from 'bcryptjs';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { COFOUNDER_PERMISSIONS, PERMISSIONS, SYSTEM_ACCOUNTS } from './constants.js';
import { connectDatabase, disconnectDatabase } from './db.js';
import { BankAccount, CoFounder, CompanySettings, LedgerAccount, User } from './models.js';
import { createFounderAccount } from './services/finance.js';
import { runTxn } from './services/accounting.js';

export async function ensureFoundation() {
  await CompanySettings.updateOne(
    { _id: 'company' },
    {
      $setOnInsert: {
        _id: 'company',
        companyName: 'DARK MEDIA',
        legalName: 'Dark Media',
        currency: 'INR',
        timezone: 'Asia/Kolkata',
        financialYearStartMonth: 4,
        invoicePrefix: 'DM',
        profitSharingActive: false,
        paymentInstructions: 'Pay by bank transfer and quote the invoice number.',
      },
    },
    { upsert: true },
  );

  for (const account of SYSTEM_ACCOUNTS) {
    await LedgerAccount.updateOne(
      { code: account.code },
      { $setOnInsert: { ...account, isSystem: true, status: 'active', ownerType: 'system' } },
      { upsert: true },
    );
  }

  const cashLedger = await LedgerAccount.findOne({ code: '1000' });
  let cash = await BankAccount.findOne({ isSystem: true, accountType: 'cash' });
  if (!cash) {
    cash = await BankAccount.create({
      accountName: 'Company Cash',
      bankName: 'Cash',
      accountHolder: 'DARK MEDIA',
      accountType: 'cash',
      openingBalancePaise: 0,
      currentBalancePaise: 0,
      allowOverdraft: false,
      status: 'active',
      isSystem: true,
      ledgerAccountId: cashLedger._id,
    });
  }
  if (!cashLedger.bankAccountId) {
    cashLedger.bankAccountId = cash._id;
    cashLedger.ownerType = 'bank';
    cashLedger.ownerId = cash._id;
    await cashLedger.save();
  }

  let createdLogin = false;
  for (const seed of config.founders) {
    let founder = await CoFounder.findOne({ seedKey: seed.seedKey });
    if (!founder) {
      const emailTaken = await CoFounder.findOne({ email: seed.email.toLowerCase() });
      founder = await CoFounder.create({
        seedKey: seed.seedKey,
        fullName: seed.fullName,
        email: emailTaken ? `${seed.seedKey}.${seed.email.toLowerCase()}` : seed.email.toLowerCase(),
        designation: 'Co-Founder',
        joiningDate: new Date(),
        ownershipBps: 0,
        profitShareBps: 0,
        accessPermissions: seed.role === 'master_admin' ? PERMISSIONS : COFOUNDER_PERMISSIONS,
        accountStatus: 'active',
      });
    }
    if (!founder.ledgerAccountId) {
      await runTxn(async (session) => {
        const fresh = await CoFounder.findById(founder._id).session(session);
        await createFounderAccount(session, fresh);
      });
      founder = await CoFounder.findById(founder._id);
    }
    let user = await User.findOne({ $or: [{ coFounderId: founder._id }, { email: founder.email }] });
    if (!user) {
      user = await User.create({
        email: founder.email,
        name: founder.fullName,
        role: seed.role,
        permissions: seed.role === 'master_admin' ? PERMISSIONS : founder.accessPermissions,
        coFounderId: founder._id,
        status: 'active',
        passwordHash: await bcrypt.hash(config.devPassword, 12),
      });
      createdLogin = true;
    } else if (!user.coFounderId) {
      user.coFounderId = founder._id;
      await user.save();
    }
    if (!founder.userId || String(founder.userId) !== String(user._id)) {
      founder.userId = user._id;
      await founder.save();
    }
  }

  const master = await User.findOne({ role: 'master_admin', status: 'active' });
  if (master && master.email !== config.loginEmail) {
    const clash = await User.findOne({ email: config.loginEmail });
    if (!clash) {
      master.email = config.loginEmail;
      await master.save();
    }
  }

  return { createdLogin };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    await connectDatabase();
    await ensureFoundation();
    console.log('Dark Media foundation is ready.');
    console.log('Co-founders: Sajeel (master admin), Shakeeb, Ismail.');
    console.log('Ownership and profit shares start at 0% until the co-founders set them.');
    if (config.allowDevAuth) {
      console.log(`Development sign-in password: ${config.devPassword}`);
      for (const founder of config.founders) console.log(`  ${founder.fullName}: ${founder.email}`);
    }
    await disconnectDatabase();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
