#!/bin/bash
# Create one persistent, certificate-backed local signing identity. TCC keys
# privacy grants to this identity + bundle identifier, so rebuilt OpenMausBot
# versions do not look like unrelated applications. Nothing is exported from
# the login keychain or committed to the repository.
set -euo pipefail

identity="${OPENMAUSBOT_CODESIGN_IDENTITY:-OpenMausBot Local Development}"
keychain="$HOME/Library/Keychains/login.keychain-db"

if /usr/bin/security find-identity -v -p codesigning "$keychain" 2>/dev/null \
  | /usr/bin/grep -Fq "\"$identity\""; then
  echo "Code-signing identity already available: $identity"
  exit 0
fi

workdir="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/openmausbot-codesign.XXXXXX")"
trap '/bin/rm -rf "$workdir"' EXIT

/bin/cat > "$workdir/openssl.cnf" <<EOF
[req]
prompt = no
distinguished_name = dn
x509_extensions = extensions

[dn]
CN = $identity
O = OpenMausBot Local
OU = Local Code Signing

[extensions]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
EOF

/usr/bin/openssl req -new -newkey rsa:3072 -x509 -sha256 -days 3650 -nodes \
  -config "$workdir/openssl.cnf" \
  -keyout "$workdir/identity.key" \
  -out "$workdir/identity.crt" >/dev/null 2>&1

password="$(/usr/bin/openssl rand -hex 24)"
/usr/bin/openssl pkcs12 -export \
  -inkey "$workdir/identity.key" \
  -in "$workdir/identity.crt" \
  -name "$identity" \
  -passout "pass:$password" \
  -out "$workdir/identity.p12"

/usr/bin/security import "$workdir/identity.p12" \
  -k "$keychain" -P "$password" -T /usr/bin/codesign -T /usr/bin/security
/usr/bin/security add-trusted-cert -d -r trustRoot -p codeSign \
  -k "$keychain" "$workdir/identity.crt"

if ! /usr/bin/security find-identity -v -p codesigning "$keychain" \
  | /usr/bin/grep -Fq "\"$identity\""; then
  echo "Failed to create the OpenMausBot code-signing identity" >&2
  exit 1
fi

echo "Created persistent code-signing identity: $identity"
