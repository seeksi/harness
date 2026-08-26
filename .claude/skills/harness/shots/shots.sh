#!/usr/bin/env bash
# Visual-diff gate: seed a throwaway checkout, run its Rails server, log in, screenshot
# routes at 1440/390 next to their mockups. Written for prospect-farm; the knobs are env.
#   shots.sh <worktree> <port> <outdir> [routes...]     (routes default: / /leads /leads/LEAD /call_session)
# Env: MAIN_REPO (bundle + master.key source), MOCK_DIR (mockup html dir), SHOTS_EMAIL, SHOTS_PASS,
#      SEED_CMD (extra seed rake, "" to skip). Never point <worktree> at a checkout whose dev DB you care about.
set -eu
WT=$1; PORT=$2; OUT=$3; shift 3
MAIN_REPO=${MAIN_REPO:-/home/alter/AGENTS/prospect-farm}
export BUNDLE_PATH=${BUNDLE_PATH:-$MAIN_REPO/vendor/bundle} RAILS_ENV=development
export MOCK_DIR=${MOCK_DIR:-$MAIN_REPO/docs/ui-mockups/redesign-2026-08}
export SHOTS_EMAIL=${SHOTS_EMAIL:-admin@prospect.farm} SHOTS_PASS=${SHOTS_PASS:-shots-pass}
SEED_CMD=${SEED_CMD-"ACCOUNT_SLUG=internal FORCE=1 bin/rails sample_data:seed"}
cd "$WT"; mkdir -p "$OUT" storage
[ -f config/master.key ] || cp "$MAIN_REPO/config/master.key" config/ 2>/dev/null || true
bin/rails db:prepare >/dev/null 2>&1
ADMIN_PASSWORD=$SHOTS_PASS bin/rails db:seed >/dev/null 2>&1
[ -n "$SEED_CMD" ] && sh -c "$SEED_CMD" >/dev/null 2>&1 || true
bin/rails tailwindcss:build >/dev/null 2>&1
# force the login user past verification + terms gates
bin/rails runner 'u=User.find_by!(email_address:ENV["SHOTS_EMAIL"]); u.password=ENV["SHOTS_PASS"]; u.email_verified_at||=Time.current; u.save!(validate:false); u.update_columns(terms_accepted_at: Time.current, terms_version: LegalHelper.config["effective_date"].to_s)' 2>&1 | tail -2
[ -f "$OUT/server.pid" ] && kill "$(cat "$OUT/server.pid")" 2>/dev/null; sleep 1; rm -f "$OUT/server.pid"
bin/rails server -p "$PORT" -P "$OUT/server.pid" >"$OUT/server.log" 2>&1 &
for i in $(seq 1 60); do curl -s -o /dev/null "http://127.0.0.1:$PORT/session/new" && break; sleep 1; done
LEAD=$(bin/rails runner 'Current.account=Account.find_by(slug:"internal"); puts Lead.order(:id).first&.id' 2>/dev/null | tail -1)
bundle exec ruby "$(dirname "$0")/shots.rb" "$PORT" "$OUT" "$LEAD" "$@" || true
kill "$(cat "$OUT/server.pid")" 2>/dev/null || true
# side-by-side montages when ImageMagick is present
if command -v montage >/dev/null; then
  for m in "$OUT"/mock-*.png; do a="$OUT/app-${m##*/mock-}"; [ -f "$a" ] && montage "$m" "$a" -tile 2x1 -geometry +8+0 -background '#111' "$OUT/side-${m##*/mock-}"; done
fi
ls "$OUT"/*.png
