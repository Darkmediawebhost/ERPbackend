import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../../.env') });
dotenv.config({ path: path.resolve(here, '../.env') });

const production = process.env.NODE_ENV === 'production';

function optional(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

const jwtSecret = optional('JWT_SECRET', production ? '' : 'dev-only-darkmedia-secret-change-me');

if (production && jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be at least 32 characters in production');
}

export const config = {
  production,
  port: Number(process.env.PORT || 4000),
  mongoUri: optional('MONGODB_URI', 'mongodb://127.0.0.1:27017/darkmedia?replicaSet=rs0'),
  jwtSecret,
  clientOrigin: optional('CLIENT_ORIGIN', 'http://localhost:5173'),
  allowDevAuth: !production && optional('ALLOW_DEV_AUTH', 'true') !== 'false',
  devPassword: optional('DEV_LOGIN_PASSWORD', 'DarkMedia@2026'),
  loginEmail: optional('LOGIN_EMAIL', 'darkmediatech4@gmail.com').toLowerCase(),
  trustProxy: process.env.TRUST_PROXY === 'true',
  founders: [
    { seedKey: 'sajeel', fullName: 'Sajeel', email: optional('FOUNDER_SAJEEL_EMAIL', 'sajeel@darkmedia.local'), role: 'master_admin' },
    { seedKey: 'shakeeb', fullName: 'Shakeeb', email: optional('FOUNDER_SHAKEEB_EMAIL', 'shakeeb@darkmedia.local'), role: 'cofounder' },
    { seedKey: 'ismail', fullName: 'Ismail', email: optional('FOUNDER_ISMAIL_EMAIL', 'ismail@darkmedia.local'), role: 'cofounder' },
  ],
  google: {
    clientId: optional('GOOGLE_CLIENT_ID'),
  },
  smtp: {
    host: optional('SMTP_HOST'),
    port: Number(process.env.SMTP_PORT || 587),
    user: optional('SMTP_USER'),
    pass: optional('SMTP_PASS').replace(/\s/g, ''),
    from: optional('SMTP_FROM'),
  },
};

export const googleReady = Boolean(config.google.clientId);

export const smtpReady = Boolean(config.smtp.host && config.smtp.from && config.smtp.user && config.smtp.pass);
