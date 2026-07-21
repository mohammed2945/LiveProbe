#!/bin/sh
set -eu

is_compatible_jdk() {
  [ -x "$1/bin/javac" ] || return 1
  major=$($1/bin/javac -version 2>&1 | awk '{
    split($2, version, ".");
    if (version[1] == "1") print version[2]; else print version[1]
  }')
  [ "$major" -ge 17 ]
}

if [ -n "${JAVA_HOME:-}" ] && is_compatible_jdk "$JAVA_HOME"; then
  JDK_HOME=$JAVA_HOME
elif command -v javac >/dev/null 2>&1; then
  JAVAC=$(command -v javac)
  CANDIDATE=$(CDPATH= cd -- "$(dirname -- "$JAVAC")/.." && pwd)
  if is_compatible_jdk "$CANDIDATE"; then
    JDK_HOME=$CANDIDATE
  fi
fi

if [ -z "${JDK_HOME:-}" ] && command -v brew >/dev/null 2>&1; then
  CANDIDATE=$(brew --prefix openjdk 2>/dev/null || true)
  if [ -n "$CANDIDATE" ] && is_compatible_jdk "$CANDIDATE"; then
    JDK_HOME=$CANDIDATE
  fi
fi

if [ -z "${JDK_HOME:-}" ]; then
  echo "JDK 17+ is required" >&2
  exit 127
fi

export JAVA_HOME=$JDK_HOME
export PATH=$JAVA_HOME/bin:$PATH
exec "$@"
