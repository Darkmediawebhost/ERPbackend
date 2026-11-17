import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { User } from './models.js';
import { HttpError } from './errors.js';

const cookieName = 'dm_session';

export function hasPerm(user, permission) {
  if (!user || user.status !== 'active') return false;
  if (user.role === 'master_admin') return true;
  return Boolean(user.permissions?.includes(permission));
}

export function signToken(user) {
  return jwt.sign({ sub: String(user._id), tv: user.tokenVersion || 0 }, config.jwtSecret, { expiresIn: '12h' });
}

function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: config.production ? 'none' : 'lax',
    secure: config.production,
    path: '/',
  };
}

export function issueSession(res, user) {
  const token = signToken(user);
  res.cookie(cookieName, token, {
    ...sessionCookieOptions(),
    maxAge: 12 * 60 * 60 * 1000,
  });
  return token;
}

export function clearSession(res) {
  res.clearCookie(cookieName, sessionCookieOptions());
}

export function presentUser(user) {
  return {
    id: user._id,
    email: user.email,
    name: user.name,
    photoURL: user.photoURL || '',
    role: user.role,
    permissions: user.role === 'master_admin' ? ['*'] : user.permissions,
    coFounderId: user.coFounderId,
    employeeId: user.employeeId,
    status: user.status,
    theme: user.theme,
    notificationPrefs: user.notificationPrefs,
    hasPassword: Boolean(user.passwordHash),
    lastLoginAt: user.lastLoginAt,
  };
}

export async function requireUser(req, _res, next) {
  try {
    const header = req.get('authorization') || '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
    const token = req.cookies?.[cookieName] || bearer;
    if (!token) throw new HttpError('Sign in to continue', 401);
    const payload = jwt.verify(token, config.jwtSecret);
    const user = await User.findById(payload.sub).select('+passwordHash');
    if (!user || user.status !== 'active' || user.tokenVersion !== payload.tv) {
      throw new HttpError('Your session has ended. Sign in again.', 401);
    }
    req.user = user;
    next();
  } catch (error) {
    if (error instanceof HttpError) return next(error);
    return next(new HttpError('Your session has ended. Sign in again.', 401));
  }
}

export function requirePerm(...permissions) {
  return (req, _res, next) => {
    if (permissions.some((permission) => hasPerm(req.user, permission))) return next();
    return next(new HttpError('You do not have permission to do that', 403));
  };
}
