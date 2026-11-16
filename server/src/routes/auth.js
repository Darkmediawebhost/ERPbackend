import bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { clearSession, hasPerm, issueSession, presentUser, requirePerm, requireUser } from '../auth.js';
import { config, googleReady, smtpReady } from '../config.js';
import { PERMISSIONS } from '../constants.js';
import { HttpError } from '../errors.js';
import { parse, wrap } from '../http.js';
import { LoginCode, User } from '../models.js';
import { recordAudit } from '../audit.js';
import { sendMail } from '../services/mail.js';

const router = Router();
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

function assertLoginEmail(email) {
  if (email !== config.loginEmail) {
    throw new HttpError(`Only ${config.loginEmail} can sign in`, 403);
  }
}

async function resolveLoginUser(email) {
  assertLoginEmail(email);
  let user = await User.findOne({ email }).select('+passwordHash');
  if (!user) {
    user = await User.findOne({ role: 'master_admin', status: 'active' }).select('+passwordHash');
    if (!user) throw new HttpError('The master admin account is not ready yet', 503);
    user.email = email;
  }
  if (user.status !== 'active') throw new HttpError('This account is deactivated', 403);
  return user;
}

async function finishLogin(req, res, user, summary) {
  user.lastLoginAt = new Date();
  await user.save();
  const token = issueSession(res, user);
  recordAudit(req, { action: 'login', entityType: 'user', entityId: user._id, summary });
  res.json({ data: presentUser(user), token });
}

router.get('/config', (_req, res) => {
  res.json({
    data: {
      loginEmail: config.loginEmail,
      google: googleReady,
      googleClientId: config.google.clientId,
      otp: smtpReady,
      company: 'DARK MEDIA',
    },
  });
});

async function googleProfile(accessToken) {
  const infoResponse = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`);
  if (!infoResponse.ok) throw new HttpError('Google did not accept that sign-in. Try again.', 401);
  const info = await infoResponse.json();
  const audience = info.aud || info.azp;
  if (audience !== config.google.clientId) throw new HttpError('This Google sign-in was not issued for Dark Media', 401);
  if (String(info.email_verified) !== 'true') throw new HttpError('This Google account has no verified email address', 400);
  const profileResponse = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const profile = profileResponse.ok ? await profileResponse.json() : {};
  const email = String(info.email || profile.email || '').toLowerCase();
  if (!email) throw new HttpError('This Google account has no email address', 400);
  return { email, name: profile.name || '', picture: profile.picture || '' };
}

router.post('/google', limiter, wrap(async (req, res) => {
  if (!googleReady) {
    throw new HttpError('Add GOOGLE_CLIENT_ID from Google Cloud to .env, then restart the API. Firebase is not used.', 503);
  }
  const { accessToken } = parse(z.object({ accessToken: z.string().min(20) }), req.body);
  const profile = await googleProfile(accessToken);
  const user = await resolveLoginUser(profile.email);
  if (profile.picture) user.photoURL = profile.picture;
  if (profile.name) user.name = profile.name;
  await finishLogin(req, res, user, `${user.name} signed in with Google`);
}));

router.post('/otp/request', limiter, wrap(async (req, res) => {
  const body = parse(z.object({ email: z.string().email() }), req.body);
  const email = body.email.toLowerCase();
  assertLoginEmail(email);
  if (!smtpReady) {
    throw new HttpError('Gmail cannot send the code yet. Create a Google App Password and put it in SMTP_PASS, then restart the API.', 503);
  }
  const code = String(randomInt(100000, 1000000));
  await LoginCode.updateMany({ email, used: false }, { used: true });
  await LoginCode.create({
    email,
    codeHash: await bcrypt.hash(code, 8),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });
  await sendMail({
    to: email,
    subject: 'Your Dark Media sign-in code',
    text: `Your Dark Media sign-in code is ${code}.\n\nIt expires in 10 minutes. If you did not ask for this, ignore this email.`,
  });
  res.json({ data: { sent: true, email } });
}));

router.post('/otp/verify', limiter, wrap(async (req, res) => {
  const body = parse(z.object({ email: z.string().email(), code: z.string().regex(/^\d{6}$/) }), req.body);
  const email = body.email.toLowerCase();
  assertLoginEmail(email);
  const entry = await LoginCode.findOne({ email, used: false }).sort({ createdAt: -1 });
  if (!entry || entry.expiresAt.getTime() < Date.now()) {
    throw new HttpError('That code has expired. Send a new one.', 401);
  }
  if (entry.attempts >= 5) throw new HttpError('Too many attempts. Send a new code.', 429);
  const matches = await bcrypt.compare(body.code, entry.codeHash);
  if (!matches) {
    entry.attempts += 1;
    await entry.save();
    throw new HttpError('That code is incorrect', 401);
  }
  entry.used = true;
  await entry.save();
  const user = await resolveLoginUser(email);
  await finishLogin(req, res, user, `${user.name} signed in with a Gmail code`);
}));

router.post('/dev', limiter, wrap(async (req, res) => {
  if (!config.allowDevAuth) throw new HttpError('Not found', 404);
  const body = parse(z.object({ email: z.string().email(), password: z.string().min(1) }), req.body);
  const user = await User.findOne({ email: body.email.toLowerCase() }).select('+passwordHash');
  if (!user?.passwordHash || !(await bcrypt.compare(body.password, user.passwordHash))) {
    throw new HttpError('Email or password is incorrect', 401);
  }
  if (user.status !== 'active') throw new HttpError('This account is deactivated', 403);
  user.lastLoginAt = new Date();
  await user.save();
  const token = issueSession(res, user);
  res.json({ data: presentUser(user), token });
}));

router.post('/logout', (req, res) => {
  clearSession(res);
  res.json({ data: { ok: true } });
});

router.get('/me', requireUser, (req, res) => {
  res.json({ data: presentUser(req.user) });
});

router.post('/sessions/revoke', requireUser, wrap(async (req, res) => {
  req.user.tokenVersion += 1;
  await req.user.save();
  issueSession(res, req.user);
  res.json({ data: presentUser(req.user) });
}));

router.patch('/me', requireUser, wrap(async (req, res) => {
  const body = parse(z.object({
    name: z.string().trim().min(1).max(120).optional(),
    theme: z.enum(['light', 'dark', 'system']).optional(),
    notificationPrefs: z.object({
      payments: z.boolean(),
      projects: z.boolean(),
      tasks: z.boolean(),
      meetings: z.boolean(),
      salary: z.boolean(),
      invoices: z.boolean(),
      calendar: z.boolean(),
    }).optional(),
    currentPassword: z.string().optional(),
    newPassword: z.string().min(8).max(80).optional(),
  }), req.body);
  if (body.name) req.user.name = body.name;
  if (body.theme) req.user.theme = body.theme;
  if (body.notificationPrefs) req.user.notificationPrefs = body.notificationPrefs;
  if (body.newPassword) {
    if (!req.user.passwordHash || !body.currentPassword || !(await bcrypt.compare(body.currentPassword, req.user.passwordHash))) {
      throw new HttpError('Current password is incorrect', 400);
    }
    req.user.passwordHash = await bcrypt.hash(body.newPassword, 12);
  }
  await req.user.save();
  res.json({ data: presentUser(req.user) });
}));

router.get('/users', requireUser, requirePerm('users.manage'), wrap(async (_req, res) => {
  const users = await User.find().sort({ name: 1 });
  res.json({ data: users.map((user) => presentUser(user)), permissions: PERMISSIONS });
}));

router.patch('/users/:id', requireUser, requirePerm('users.manage'), wrap(async (req, res) => {
  const body = parse(z.object({
    role: z.enum(['master_admin', 'cofounder', 'employee', 'viewer']).optional(),
    permissions: z.array(z.string()).optional(),
    status: z.enum(['active', 'disabled']).optional(),
  }), req.body);
  const user = await User.findById(req.params.id);
  if (!user) throw new HttpError('User not found', 404);
  if (user.role === 'master_admin' && (body.role && body.role !== 'master_admin' || body.status === 'disabled')) {
    const remaining = await User.countDocuments({ role: 'master_admin', status: 'active', _id: { $ne: user._id } });
    if (!remaining) throw new HttpError('The company needs at least one active master admin');
  }
  if (body.role) user.role = body.role;
  if (body.permissions) {
    user.permissions = body.permissions.filter((permission) => PERMISSIONS.includes(permission));
  }
  if (body.status) user.status = body.status;
  if (body.role || body.status) user.tokenVersion += 1;
  await user.save();
  recordAudit(req, { action: 'permissions', entityType: 'user', entityId: user._id, summary: `Updated access for ${user.name}` });
  res.json({ data: presentUser(user) });
}));

export function can(user, permission) {
  return hasPerm(user, permission);
}

export default router;
