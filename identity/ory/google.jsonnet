// A Google account as a Kratos identity: email_verified is trusted only for
// Gmail addresses or Google Workspace domains (non-empty `hd`), because
// Google documents that external-mailbox accounts may keep email_verified: true
// after mailbox ownership changes.
local claims = std.extVar('claims');
local email = if std.objectHas(claims, 'email') && std.isString(claims.email) then std.asciiLower(claims.email) else '';
local authoritative =
  std.endsWith(email, '@gmail.com') ||
  std.endsWith(email, '@googlemail.com') ||
  (std.objectHas(claims, 'hd') && std.isString(claims.hd) && claims.hd != '');
local verified =
  email != '' &&
  std.objectHas(claims, 'email_verified') &&
  claims.email_verified == true &&
  authoritative;
{
  identity: {
    traits: {
      [if verified then 'email']: claims.email,
      [if std.objectHas(claims, 'name') then 'name']: claims.name,
    },
    verified_addresses: if verified then [{ via: 'email', value: claims.email }] else [],
  },
}
