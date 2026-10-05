#!/usr/bin/env bash
source "$(dirname "$0")/../bin/_lib.sh"
input="$(cat)"
command -v jq >/dev/null || exit 0
LC_ALL=C # bytewise string handling in this script; bash 3.2 is much slower on long text in a UTF-8 locale

deny() { echo "harness guard: $1" >&2; exit 2; }

tool="$(printf '%s' "$input" | jq -r '.tool_name // empty')"
agent="$(printf '%s' "$input" | jq -r '.agent_id // empty')"
case "$tool" in
  Agent|Task) [ -n "$agent" ] && deny "sub-agents must not spawn sub-agents; do the work yourself or report back to the orchestrator." ; exit 0 ;;
esac

cwd="$(printf '%s' "$input" | jq -r '.cwd // empty')"
role="$(printf '%s' "$input" | jq -r '.agent_type // empty')"

if [ "$role" = "implementer" ]; then
  handoff="writing tests and running the app belong to the tester and verifier. Commit your code after static checks and the unit tests for the files you touched, and list what needs testing in your report."
  case "$tool" in
    mcp__*)
      printf '%s' "$tool" | grep -Eqi 'browser|chrome|simulator|ios|android|blender|godot|playwright|puppeteer|screenshot|preview|computer' \
        && deny "implementers don't run apps, browsers, simulators or 3D tools; $handoff"
      ;;
    Edit|Write)
      path="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')"
      printf '%s' "$path" | grep -Eqi '(^|/)(tests?|__tests__|spec|specs|e2e|cypress|playwright)(/|$)|[._-](test|spec)\.[a-z0-9]+$|(^|/)test_[^/]+$' \
        && deny "implementers don't write tests; $handoff"
      ;;
    Bash)
      c="$(printf '%s' "$input" | jq -r '.tool_input.command // empty | if type == "array" then join(" ") else . end')"
      printf '%s' "$c" | grep -Eqi '(^|[;&|[:space:]])((npm|pnpm|yarn|bun)([[:space:]]+run)?[[:space:]]+(dev|start|preview|serve|ios|android|web)([[:space:]]|$)|(npx[[:space:]]+)?expo[[:space:]]+(start|run)|electron([[:space:]]|-vite[[:space:]]+(dev|preview))|screencapture|xcrun[[:space:]]+simctl|open[[:space:]]+-a[[:space:]]+(simulator|blender|godot)|[^[:space:]]*(godot|blender)[^[:space:]]*[[:space:]].*(--run|--scene|-s[[:space:]]))' \
        && deny "implementers don't start apps, dev servers or simulators; $handoff"
      ;;
  esac
fi

# env-file basename check, shared by the Read/Grep path and the Bash path.
is_env_path() {
  case "$(basename -- "$1" 2>/dev/null)" in
    .env) return 0 ;;
    .env.example|.env.sample|.env.template) return 1 ;;
    .env.*) return 0 ;;
  esac
  return 1
}

case "$tool" in
  Read|Grep)
    path="$(printf '%s' "$input" | jq -r '(.tool_input.file_path // .tool_input.path // empty)')"
    if [ -n "$path" ] && is_env_path "$path"; then
      deny "don't read .env files; pass secrets by reference (source / --env-file)."
    fi
    exit 0
    ;;
esac

cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty | if type == "array" then join(" ") else . end')"
[ -n "$cmd" ] || exit 0

# .env reads via shell readers/searchers: match the path token independently of
# what precedes it (flags, other args), excluding .env.example/.sample/.template.
reader_re='(^|[[:space:]])(cat|less|more|head|tail|bat|strings|base64|xxd|od|grep|egrep|fgrep|sed|awk|jq)([[:space:]]|$)'
env_token_re='(^|[/"'\''[:space:]=])\.env(\.[a-zA-Z_]+)?(["'\''[:space:]]|$)'
env_example_re='\.env\.(example|sample|template)(["'\''[:space:]]|$)'
case "$cmd" in *.env*)
  while IFS= read -r seg; do
    case "$seg" in *.env*) ;; *) continue ;; esac
    case "$seg" in *cat*|*less*|*more*|*head*|*tail*|*bat*|*strings*|*base64*|*xxd*|*od*|*grep*|*sed*|*awk*|*jq*) ;; *) continue ;; esac
    [[ $seg =~ $reader_re ]] || continue
    [[ $seg =~ $env_token_re ]] || continue
    [[ $seg =~ $env_example_re ]] && continue
    deny "don't read .env files; pass secrets by reference (source / --env-file)."
  done <<< "$(printf '%s\n' "$cmd" | tr ';&|' '\n\n\n')"
esac

# bin/decide is the harness's only Jev client and bin/session-log the only writer of the session log;
# both act for the orchestrator, and the harness .env's keys are for these two alone. The rules below
# read the command roughly as a shell does: code segments split at ; & | ( ) newlines, $( and backticks
# outside quotes, # comments left out. Quoted text stays in its word (quotes removed, blanks as \037), so
# messages and docs are data; a `sh -c` or eval string is code. A heredoc body is data, except the $( )
# and backtick spans of an unquoted one, and all of one fed to a shell; the lines of one fed to another
# interpreter that name a .env, Jev or Supabase come out marked \035. Text after a closing ), backtick or
# -c string continues a command, not at command position (marked \036), unless the $( or backtick sat in
# the command's leading words (an assignment, a wrapper or the command word): then the command goes on,
# the substitution read as $_. One awk pass over the lines (bash 3.2 string handling is quadratic on long
# text); only commands naming bin/decide, bin/session-log or a .env are read.
split_awk='
BEGIN {
  US = "\037"; CT = "\036"; GS = "\035"; M = "\034"; q = 0; wb = 1
  SHC = "(^|[ \t/])((ba|da|z|k)?sh([ \t]+-[A-Za-z]+)*[ \t]+-[A-Za-z]*c|eval)[ \t]*$"
  ASG = "[A-Za-z_][A-Za-z0-9_]*=[^ \t]*"
  WRAP = "([^ \t]*/)?(env|exec|command|builtin|time|nohup|sudo|doas|nice|ionice|timeout|gtimeout|xargs|caffeinate|stdbuf)([ \t]+(-[^ \t]*|[0-9][^ \t]*))*"
  LEAD = "^[ \t(!{]*((" ASG "|" WRAP "|if|then|do|else|elif|while|until)[ \t]+)*(node([ \t]+-[^ \t]*)*[ \t]+)?[^ \t]*$"
  LEAD1 = "^[ \t(!{]*([A-Za-z_][A-Za-z0-9_]*=|([^ \t]*/)?(env|exec|command|builtin|time|nohup|sudo|doas|nice|ionice|timeout|gtimeout|xargs|caffeinate|stdbuf|node|if|then|do|else|elif|while|until)([ \t]|$))"
  HEAD = "^[ \t(!{]*((" ASG "|" WRAP ")[ \t]+)*([^ \t]*/)?"
  SHELL = HEAD "(ba|da|z|k)?sh([ \t]|$)"
  INTERP = HEAD "(node|nodejs|deno|bun|bunx|npx|tsx|ts-node|python[0-9.]*|pypy[0-9.]*|uv|uvx|ruby|perl|php|lua|osascript|Rscript|pwsh)([ \t]|$)"
  TOK = "[^ \t\"`(),;=+<>|&" SQ "]*[.]env([^A-Za-z0-9_.-]|$)"
  KEEP = "[.]env|--env-file|cd|source|[.][ \t]|bin/decide|bin/session-log|export"
  JEV = "typesafe|systemone|supabase|rest/v1"
}
# A segment no rule below can read (it names none of their words) is left out.
function push() { if (seg != "" && seg != CT && (seg ~ KEEP || tolower(seg) ~ JEV)) print seg; seg = "" }
function cstart(s, at) { # where a # comment starts in code text s (at: s starts a word), else 0
  if (at && substr(s, 1, 1) == "#") return 1
  return match(s, /[ \t]#/) ? RSTART + 1 : 0
}
# A line of a heredoc fed to an interpreter, for the key rule: each new word naming a .env (and the
# harness .env, when the line also names .agent-harness) comes out once, marked GS, and so does the first
# line naming Jev or Supabase.
function envline(s,  w, h) {
  if (!bj && tolower(s) ~ JEV) { bj = 1; print GS tolower(s) }
  if (!index(s, ".env")) return
  h = index(s, ".agent-harness")
  while (match(s, TOK)) {
    w = substr(s, RSTART, RLENGTH); s = substr(s, RSTART + RLENGTH)
    if (w !~ /v$/) w = substr(w, 1, length(w) - 1)
    if (w != ".env" && w !~ /\/[.]env$/) continue
    if (h && !ES["/.agent-harness/.env"]++) print GS "/.agent-harness/.env"
    if (!ES[w]++) print GS w
  }
}
function data(s) { if (q == 3) return; if (q) gsub(/[ \t]/, US, s); seg = seg s }
function lit(c) { if (q != 3) seg = seg (c == " " || c == "\t" ? US : c) }
function lead(k) { return k <= n ? substr(P[k], 1, 1) : "" }
# What a $( or backtick that opens now leaves when it closes: the command so far and $_ when the
# substitution sits in its leading words, else "" (the rest continues an argument). Past 512 bytes, a
# segment that starts with such words is read as it is now, and goes on as its first and last 128 bytes
# joined by an assignment, so that a long chain stays short.
function opening(  s) {
  if (q == 3 || seg == CT) return ""
  if (length(seg) <= 512) return seg ~ LEAD ? seg "$_" : ""
  if (substr(seg, 1, 64) !~ LEAD1) return ""
  s = substr(seg, 1, 128) "Z=$_" substr(seg, length(seg) - 127)
  if (s !~ LEAD) return ""
  push()
  return s "$_"
}
function heredoc(  r, w, k, d, quoted) { # "<" then P[i] starts with "<": a here-string, a heredoc or "<<"
  r = substr(P[i], 2); quoted = 1
  if (r == "" && lead(i + 1) == "<") { seg = seg "<<<"; rest = substr(P[i + 1], 2); i += 2; return }
  if (match(r, /^-?[ \t]*[A-Za-z_][A-Za-z0-9_]*/)) { w = substr(r, 1, RLENGTH); rest = substr(r, RLENGTH + 1); i++; quoted = 0 }
  else if (r ~ /^-?[ \t]*$/ && (d = lead(i + 1)) != "" && index("\\\"" SQ, d)) { # an escaped or quoted word
    k = i + 1; w = substr(P[k], 2)
    if (d == "\\" && match(w, /^[A-Za-z_][A-Za-z0-9_]*/)) { rest = substr(w, RLENGTH + 1); w = substr(w, 1, RLENGTH); i = k + 1 }
    else if (d != "\\" && w ~ /^[A-Za-z_][A-Za-z0-9_]*$/ && lead(k + 1) == d) { rest = substr(P[k + 1], 2); i = k + 2 }
    else { seg = seg "<<"; rest = r; i++; return }
  }
  else { seg = seg "<<"; rest = r; i++; return }
  # The body: 0 data, 1 data but for its $( ) and backtick spans (unquoted), 2 code (fed to a shell).
  sub(/^-?[ \t]*/, "", w); hd = w; hm = seg ~ SHELL ? 2 : quoted ? 0 : 1; hi = seg ~ INTERP; seg = seg "<<" w
}
{
  if (body != "") { # a heredoc body, up to its delimiter line
    t = $0; sub(/^[ \t]+/, "", t); sub(/[ \t]+$/, "", t)
    if (t == body) { body = ""; joined = 0; if (bm) { push(); q = 0; stack = bstack; bt = ""; btsv = ""; cq = ""; esc = 0 } next }
    if (bi) envline($0)
    if (!bm) next
  }
  line = $0; gsub(/\034/, "", line); u = ""
  for (k = 1; k <= length(line); k += 16384) { # in 16 KB parts: gsub slows down with many matches on one long string
    s = substr(line, k, 16384); gsub(/[;&|()<"`$\\]/, M "&", s); gsub(SQ, M SQ, s); u = u s
  }
  n = split(u, P, M); cont = 0; cmt = 0; i = 1; wb = joined ? wbn : 1; joined = 0
  while (i <= n) { # q: 0 code, 1 single quotes, 2 double quotes, 3 heredoc text; stack: the q each $( and ( returns to
    c = i == 1 ? "" : substr(P[i], 1, 1); rest = i == 1 ? P[i] : substr(P[i], 2); i++
    if (cmt) { # a comment runs to the end of the line, or to the end of the backtick or -c string it is in
      if (cend == "" || c != cend) { if (c == "\\" && rest == "" && cend != SQ) i++; continue }
      cmt = 0
    }
    b = c == "" ? -1 : 0 # for a piece that adds no text: 1 when a new word starts after it (wb, for #)
    if (esc) { esc = 0; lit(c); c = ""; b = 0 }
    if (c == "") ;
    else if (q == 1) { if (c == SQ) q = 0; else data(c) }
    else if (c == "\\") { if (rest != "") { lit(substr(rest, 1, 1)); rest = substr(rest, 2) } else if (i <= n) esc = 1; else cont = 1 }
    else if (c == "$") {
      if (rest == "" && lead(i) == "(") {
        d = length(stack) + 1; sv[d] = opening(); sk[d] = "$"; if (sv[d] == "") push(); else seg = ""
        stack = q stack; q = 0; rest = substr(P[i], 2); i++; b = 1
      } else data(c)
    }
    else if (c == "`") {
      if (bt == "") { btsv = opening(); if (btsv == "") push(); else seg = ""; bt = q ""; q = 0; b = 1 }
      else { push(); q = bt + 0; bt = ""; seg = btsv != "" ? btsv : CT; btsv = "" }
    }
    else if (q == 3) ;
    else if (q == 2) { if (c == "\"") q = 0; else data(c) }
    else if (c == SQ || c == "\"") { if (c == cq) { cq = ""; push(); seg = CT } else if (cq == "" && seg ~ SHC) { cq = c; push(); b = 1 } else q = c == SQ ? 1 : 2 }
    else if (c == "<") { if (rest == "" && lead(i) == "<") heredoc(); else data(c) }
    else if (c == ")") {
      push(); b = 1
      if (stack != "") { d = length(stack); q = substr(stack, 1, 1) + 0; stack = substr(stack, 2); seg = sv[d] != "" ? sv[d] : CT; if (sk[d] == "$") b = 0; sv[d] = sk[d] = "" }
    }
    else { if (c == "(") { stack = "0" stack; sv[length(stack)] = ""; sk[length(stack)] = "(" } push(); b = 1 }
    if (rest == "") { if (b >= 0) wb = b; continue }
    if (q == 0 && index(rest, "#") && (k = cstart(rest, b >= 0 ? b : wb))) { # a comment starts in this text
      data(substr(rest, 1, k - 1)); cmt = 1; cend = cq != "" ? cq : bt != "" ? "`" : ""; continue
    }
    data(rest); wb = rest ~ /[ \t]$/
  }
  if (q == 3) { cont = 0; push() }
  else if (cont) { joined = 1; wbn = seg == "" || seg == CT || substr(seg, length(seg)) ~ /[ \t]/ } # bash drops a backslash-newline
  else if (q) seg = seg US
  else {
    push()
    if (hd != "") { body = hd; bm = hm; bi = hi; hd = ""; bj = 0; split("", ES); if (bm) { bstack = stack; stack = ""; q = bm == 1 ? 3 : 0 } }
  }
}
END { push() }
'
code_segments() { # $1 command → segs
  local out IFS=$'\n'
  out="$(printf '%s\n' "$1" | LC_ALL=C awk -v SQ="'" "$split_awk" 2>/dev/null)"
  set -f; segs=($out); set +f
}

# The live harness: the repo this hook runs from, and ~/.agent-harness; symlinks resolved.
here="" home_harness=""
live_dir() { # $1 dir → 0 when it is the live harness, or relative or a variable the guard can't resolve
  local d=$1 r
  case $d in "~"|"~/"*) d=$HOME${d#\~} ;; '$HOME'|'$HOME/'*) d=$HOME${d#\$HOME} ;; '${HOME}'|'${HOME}/'*) d=$HOME${d#\$\{HOME\}} ;; esac
  case $d in *'$'*) return 0 ;; /*) ;; *) return 0 ;; esac
  [ -n "$here" ] || here="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd -P)" home_harness="$(cd "$HOME/.agent-harness" 2>/dev/null && pwd -P)"
  r="$(cd "$d" 2>/dev/null && pwd -P)" || r=${d%/}
  [ "$r" = "$here" ] || [ "$r" = "${home_harness:-$HOME/.agent-harness}" ] || [ "${d%/}" = "$HOME/.agent-harness" ]
}
scratch_dir() { # $1 a HARNESS_DIR value → 0 when it is an absolute path to a scratch harness
  case $1 in ""|*/.|*/./*|*/..|*/../*) return 1 ;; esac
  ! live_dir "$1"
}
harness_env() { # $1 a path as written, $2 the dir it is relative to → 0 when it is the live harness's .env
  local p=${1//$us/ } d
  case $p in /*|"~"*|'$HOME'*|'${HOME}'*) ;; *) p=$2/$p ;; esac
  case $p in "~/"*) p=$HOME${p#\~} ;; '$HOME/'*) p=$HOME${p#\$HOME} ;; '${HOME}/'*) p=$HOME${p#\$\{HOME\}} ;; esac
  [ "${p##*/}" = .env ] || return 1
  case $p in */.agent-harness/.env) return 0 ;; *'$'*) return 1 ;; /*) ;; *) return 1 ;; esac
  d=${p%/*}
  live_dir "${d:-/}"
}
env_named() { # $1 an interpreter's code → 0 when it names the live harness .env (also built from parts)
  local s=$1
  case $s in *.agent-harness*) [[ $s =~ $envname_re ]] && return 0 ;; esac
  while [[ $s =~ $envtok_re ]]; do
    harness_env "${BASH_REMATCH[1]}" "$wd" && return 0
    s=${BASH_REMATCH[3]}
  done
  return 1
}
env_redirect() { # $1 a segment → 0 when a < redirect, $(< …) too, reads the live harness .env
  local s=$1
  while [[ $s =~ $redir_re ]]; do
    harness_env "${BASH_REMATCH[2]}" "$wd" && return 0
    s=${BASH_REMATCH[3]}
  done
  return 1
}

nl=$'\n' us=$'\037' rs=$'\036' gs=$'\035'
var_re="[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*"
wrap_re="([^[:space:]]*/)?(env|exec|command|builtin|time|nohup|sudo|doas|nice|ionice|timeout|gtimeout|xargs|caffeinate|stdbuf)([[:space:]]+(-[^[:space:]]*|[0-9][^[:space:]]*))*"
lead0="^[[:space:](!{]*((${var_re}|${wrap_re}|if|then|do|else|elif|while|until)[[:space:]]+)*"
lead_re="${lead0}(node([[:space:]]+-[^[:space:]]*)*[[:space:]]+)?[^[:space:]]*"
interp_re="${lead0}([^[:space:]]*/)?(node|nodejs|deno|bun|bunx|npx|tsx|ts-node|python[0-9.]*|pypy[0-9.]*|uv|uvx|ruby|perl|php|lua|osascript|Rscript|pwsh)([[:space:]]|\$)"
envtok_re="([^[:space:]${us}'\"\`(),;=+<>|&]*\\.env)([^A-Za-z0-9_.-]|\$)(.*)"
envname_re="(^|[^A-Za-z0-9_])\\.env([^A-Za-z0-9_.-]|\$)"
redir_re="(^|[^<])<[[:space:]]*([^[:space:]${us}<>&|;()]+)(.*)"
decide_re="${lead_re}bin/decide([[:space:]]|\$)"
log_re="${lead_re}bin/session-log([[:space:]]|\$)"
source_re="^[[:space:](!{]*((${var_re}|${wrap_re}|if|then|do|else|elif|while|until)[[:space:]]+)*(source|\\.)[[:space:]]+([^[:space:]]+)"
envfile_re="(^|[[:space:]])--env-file(-if-exists)?(=|[[:space:]]+)([^[:space:]]+)(.*)"
cd_re="^[[:space:](!{]*cd[[:space:]]+([^[:space:]]+)"
export_re='^[[:space:]]*export[[:space:]]'
url_re='.*[[:space:]]TYPESAFE_BASE_URL=([^[:space:]]*)'
dir_re='.*[[:space:]]HARNESS_DIR=([^[:space:]]*)'
loopback_re='^https?://(localhost|127\.[0-9.]+|\[::1\])([:/]|$)'
segs=() points="" logs="" exports="" loads="" wd="$cwd"
case "$cmd" in *bin/decide*|*bin/session-log*|*.env*) code_segments "$cmd" ;; esac
for seg in "${segs[@]}"; do
  case $seg in "$gs"*) # a line of a heredoc fed to an interpreter
    if [ -z "$loads" ] && env_named "${seg#"$gs"}"; then loads=1; fi
    continue ;;
  esac
  case $seg in *.env*)
    if [ -z "$loads" ]; then
      case $seg in *'<'*) env_redirect "$seg" && loads=1 ;; esac
      case $seg in
        "$rs"*) ;;
        *node*|*deno*|*bun*|*npx*|*tsx*|*python*|*pypy*|*uv*|*ruby*|*perl*|*php*|*lua*|*osascript*|*Rscript*|*pwsh*)
          [[ $seg =~ $interp_re ]] && env_named "$seg" && loads=1 ;;
      esac
    fi ;;
  esac
  case $seg in *--env-file*)
    rest=${seg#"$rs"}
    while [[ $rest =~ $envfile_re ]]; do
      harness_env "${BASH_REMATCH[4]}" "$wd" && loads=1
      rest=${BASH_REMATCH[5]}
    done ;;
  esac
  case $seg in "$rs"*) continue ;; *cd*|*source*|*.[[:space:]]*|*bin/decide*|*bin/session-log*|*export*) ;; *) continue ;; esac
  if [[ $seg =~ $cd_re ]]; then
    case ${BASH_REMATCH[1]} in /*|"~"*|'$HOME'*|'${HOME}'*) wd=${BASH_REMATCH[1]} ;; *) wd=$wd/${BASH_REMATCH[1]} ;; esac
  fi
  [[ $seg =~ $source_re ]] && harness_env "${BASH_REMATCH[${#BASH_REMATCH[@]}-1]}" "$wd" && loads=1
  if [[ $seg =~ $decide_re ]]; then
    pre=${BASH_REMATCH[0]}
    read -r sub _ <<< "${seg:${#pre}}"
    case "$sub" in
      level|recipe|ui|start) points="$points$nl $exports $pre" ;;
      ""|stages|check|-h|--help) ;;
      *) deny "unknown decision point '${sub//$us/ }' for bin/decide: use level, recipe, ui or start (stages and check need no Jev)." ;;
    esac
  elif [[ $seg =~ $log_re ]]; then
    pre=${BASH_REMATCH[0]}
    read -r sub _ <<< "${seg:${#pre}}"
    case "$sub" in ""|-h|--help) ;; *) logs="$logs$nl $exports $pre" ;; esac
  elif [[ $seg =~ $export_re ]]; then
    exports="$exports $seg"
  fi
done

# A sub-agent decides only in tests: against a scratch harness (an absolute HARNESS_DIR that is not the
# live harness) and a loopback TYPESAFE_BASE_URL, both set for decide itself (on its command or exported
# before it). It runs bin/session-log only against a scratch harness, too.
if [ -n "$agent" ] && [ -n "$points" ]; then
  while IFS= read -r pre; do
    [ -n "$pre" ] || continue
    jev_url="" hdir=""
    [[ $pre =~ $url_re ]] && jev_url=${BASH_REMATCH[1]}
    [[ $pre =~ $dir_re ]] && hdir=${BASH_REMATCH[1]//$us/ }
    [ -n "$hdir" ] && [[ $jev_url =~ $loopback_re ]] \
      || deny "bin/decide decisions are the orchestrator's, at solve's fixed steps. Sub-agents may run bin/decide stages and check; tests may decide against a scratch HARNESS_DIR with a loopback TYPESAFE_BASE_URL."
    scratch_dir "$hdir" \
      || deny "a sub-agent's HARNESS_DIR must be an absolute path to a scratch harness, never the live one (~/.agent-harness or this harness)."
  done <<< "$points"
fi
if [ -n "$agent" ] && [ -n "$logs" ]; then
  while IFS= read -r pre; do
    [ -n "$pre" ] || continue
    hdir=""
    [[ $pre =~ $dir_re ]] && hdir=${BASH_REMATCH[1]//$us/ }
    scratch_dir "$hdir" \
      || deny "bin/session-log writes the orchestrator's session log; a sub-agent runs it only against a scratch HARNESS_DIR, an absolute path that is not the live harness (--help is free)."
  done <<< "$logs"
fi

# The harness .env's keys (Jev, Supabase) are only for bin/decide and bin/session-log: a command that
# loads it (source, . or --env-file, also relative to a cd into it; an interpreter naming it in its code
# or heredoc; a < redirect or $(< …) from it) and names Jev or Supabase in its code is denied. A project's
# own Jev or Supabase use, with its own .env, is not touched.
if [ -n "$loads" ] && printf '%s\n' "${segs[@]}" | grep -Eqi 'typesafe|systemone|supabase|rest/v1'; then
  deny "the harness .env's keys are only for bin/decide and bin/session-log; a project calls Jev or Supabase with its own keys."
fi

# Global git options before the subcommand, e.g. `--no-pager`, `-c k=v`, `-C <path>`.
git_opts='(-C[[:space:]]+[^[:space:]]+|-c[[:space:]]+[^[:space:]]+|--no-pager|--paginate|--git-dir=[^[:space:]]+|--work-tree=[^[:space:]]+|--)'
git_re="(^|[;&|[:space:]])git([[:space:]]+${git_opts})*[[:space:]]+(push|commit)([[:space:]]|\$)"
printf '%s' "$cmd" | grep -Eq "$git_re" || exit 0

# Extract the -C path (if any) that applies to the matched git invocation, to run
# the branch check against the right worktree instead of skipping it outright.
resolve_path() {
  local p="${1#[\"\']}"; p="${p%[\"\']}"
  case "$p" in
    "~"*) p="$HOME${p#\~}" ;;
    /*) ;;
    *) p="$2/$p" ;;
  esac
  printf '%s' "$p"
}
git_cwd="$cwd"
cd_path="$(printf '%s' "$cmd" | grep -Eo '(^|[;&|[:space:]])cd[[:space:]]+[^;&|[:space:]]+' | tail -1 | sed -E 's/^.*cd[[:space:]]+//')"
[ -n "$cd_path" ] && git_cwd="$(resolve_path "$cd_path" "$cwd")"
c_path="$(printf '%s' "$cmd" | grep -Eo '(^|[;&|[:space:]])git([[:space:]]+'"$git_opts"')*[[:space:]]+(push|commit)' | grep -Eo -- '-C[[:space:]]+[^[:space:]]+' | tail -1 | sed -E 's/^-C[[:space:]]+//')"
[ -n "$c_path" ] && git_cwd="$(resolve_path "$c_path" "$git_cwd")"

if printf '%s' "$cmd" | grep -Eq "(^|[;&|[:space:]])git([[:space:]]+${git_opts})*[[:space:]]+push"; then
  # Isolate the push segment (up to the next command separator) so unrelated
  # trailing commands (e.g. `git push -u origin x && rm -f a`) aren't scanned.
  push_seg="$(printf '%s\n' "$cmd" | grep -Eo "git([[:space:]]+${git_opts})*[[:space:]]+push[^;&|]*")"
  printf '%s' "$push_seg" | grep -Eq '[[:space:]](-f|--force|--force-with-lease)([[:space:]=]|$)|[[:space:]]\+[^[:space:]]+' && deny "never force-push."

  default="$(harness_default_branch "$git_cwd" 2>/dev/null || echo main)"
  if printf '%s' "$push_seg" | grep -Eq "[[:space:]:](refs/heads/)?(main|master|${default})([[:space:]]|\$)"; then
    deny "never push to the default branch; ship a task branch with bin/task-ship. If you believe this is wrong, ask the user rather than trying to bypass this check."
  fi
fi

# HARNESS_ALLOW_DEFAULT=1 only waives the "you're on the default branch, use
# task-start" nudge for commit; it must never waive the push-to-default deny above.
case "$cmd" in *HARNESS_ALLOW_DEFAULT=1*) exit 0 ;; esac

case "$git_cwd" in *'$'*) exit 0 ;; esac
[ -d "$git_cwd" ] || exit 0
branch="$(git -C "$git_cwd" branch --show-current 2>/dev/null)" || exit 0
default="$(harness_default_branch "$git_cwd" 2>/dev/null || echo main)"
case "$branch" in
  main|master|"$default")
    deny "you're on '$branch'. Start a task branch first: ~/.agent-harness/bin/task-start <feat|fix|chore> <slug>. (Intentional? prefix the command with HARNESS_ALLOW_DEFAULT=1.)"
    ;;
esac
exit 0
