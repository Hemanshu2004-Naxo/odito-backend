// Single source of truth for the minimum password length. Previously the
// frontend (signup form) enforced 8 characters while the backend (User
// schema) only enforced 6 — a real gap that let a 6-7 character password
// through any non-browser client. 8 was chosen (the stricter of the two)
// so no existing account's already-accepted password becomes newly invalid;
// only the floor for NEW/changed passwords moves up.
//
// Imported by:
//   - User.js (registration + the existing OTP-based password reset, both
//     of which save through this schema's own validators)
//   - changePasswordValidator.js (Change Password, Phase 2)
export const PASSWORD_MIN_LENGTH = 8;
