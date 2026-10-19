#!/bin/sh
# Local Docker only. Creates the Root (or reissues its proof) and prints the command that opens the
# activation link. The token stays in a 0600 file under volumes/secrets (ADR 0027); the printed
# command reads that file, so the secret itself never reaches the console or shell history.
# Usage: ./root-activation.sh <google-email> | ./root-activation.sh --reissue
set -eu
cd "$(dirname "$0")"
issuer=https://accounts.google.com
file="root-$(date +%Y%m%d%H%M%S).txt"
case "${1:-}" in
  '') echo "Usage: $0 <google-email> | $0 --reissue" >&2; exit 2 ;;
  --reissue) set -- reissue-root --issuer "$issuer" ;;
  *) set -- bootstrap --operation "$(uuidgen | tr 'A-Z' 'a-z')" --issuer "$issuer" --email "$1" ;;
esac
mkdir -p volumes/secrets
docker compose run --rm -v "$PWD/volumes/secrets:/out" setup \
  node tools/product.ts "$@" --activation-file "/out/$file"
path="$PWD/volumes/secrets/$file"
# Nothing written when the Root already exists (same operation) or the command was refused.
[ -f "$path" ] || exit 0
echo
echo 'Within 15 minutes, open the activation page (sign in with the same Google account):'
echo "  open \"http://localhost:6368/activate#token=\$(cat '$path')\""
echo 'Then delete the token file:'
echo "  rm '$path'"
