#!/usr/bin/env bash
# One-time: create a self-signed code-signing identity in the login keychain.
#
# Why: macOS keys Microphone / Screen Recording / System Audio grants to the app's
# code signature. An ad-hoc signature ("codesign -s -") is just a hash of the build, so
# every rebuild looks like a brand-new app — System Settings keeps showing the old
# toggle as ON while the new binary is silently denied. Signing every build with the
# same certificate gives a stable identity, so grants survive rebuilds.
#
# Idempotent: does nothing if the identity already exists.
set -euo pipefail

NAME="${SIGN_IDENTITY:-Nkemka Local Code Signing}"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-certificate -c "$NAME" "$KEYCHAIN" >/dev/null 2>&1; then
  echo "Signing identity \"$NAME\" already exists."
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/cert.cnf" <<EOF
[ req ]
distinguished_name = dn
x509_extensions    = ext
prompt             = no
[ dn ]
CN = $NAME
[ ext ]
basicConstraints       = critical, CA:false
keyUsage               = critical, digitalSignature
extendedKeyUsage       = critical, codeSigning
subjectKeyIdentifier   = hash
EOF

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" -config "$TMP/cert.cnf" >/dev/null 2>&1

# -legacy: macOS's keychain can't read the AES-based PKCS#12 that OpenSSL 3 writes by default.
LEGACY=""
openssl version | grep -q "^OpenSSL 3" && LEGACY="-legacy"
openssl pkcs12 -export $LEGACY -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
  -name "$NAME" -out "$TMP/id.p12" -passout pass:pill

# -T lets codesign use the key without a keychain prompt on every build.
security import "$TMP/id.p12" -k "$KEYCHAIN" -P pill -T /usr/bin/codesign >/dev/null

echo "Created signing identity \"$NAME\"."
