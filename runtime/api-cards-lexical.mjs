export const collapse = text => text.replace(/\s+/g, ' ').trim();
export const isIdentChar = ch => ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
