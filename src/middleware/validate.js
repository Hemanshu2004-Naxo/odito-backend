import { validationResult } from 'express-validator';

/**
 * Terminates a request with a 400 if any express-validator check in the
 * preceding chain failed. The body shape is deliberately identical to what
 * the OTP auth controllers (verifyEmailOTPController, forgotPasswordController,
 * …) already return inline, so adding this as route middleware to
 * /register and /login introduces no new error contract:
 *
 *   { success: false, message: <first failing check's message>, errors: [...] }
 *
 * Kept generic (no auth coupling) so any route can reuse it.
 */
export function validate(req, res, next) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();

  return res.status(400).json({
    success: false,
    message: errors.array()[0].msg,
    errors: errors.array(),
  });
}

export default validate;
