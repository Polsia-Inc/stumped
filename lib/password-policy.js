const PASSWORD_MIN_LENGTH = 10;

function validatePassword(password) {
  const errors = [];

  if (!password || password.length < PASSWORD_MIN_LENGTH) {
    errors.push(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }

  if (!/[a-zA-Z]/.test(password)) {
    errors.push('Password must contain at least 1 letter');
  }

  if (!/[0-9]/.test(password)) {
    errors.push('Password must contain at least 1 number');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

module.exports = {
  PASSWORD_MIN_LENGTH,
  validatePassword
};
