import nodemailer from 'nodemailer';
import { config, smtpReady } from '../config.js';
import { HttpError } from '../errors.js';

export async function sendMail({ to, subject, text, attachments }) {
  if (!smtpReady) {
    throw new HttpError('Email is not configured. Add SMTP_HOST and SMTP_FROM to the environment.', 503);
  }
  const transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
  await transport.sendMail({ from: config.smtp.from, to, subject, text, attachments });
}
