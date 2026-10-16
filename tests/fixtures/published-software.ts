export const publishedPackages = [
  {
    name: "sh",
    digest: "f606cc4caa9ba50f7022d681269ca0ea98ccffc0d29f3106a0f18ab593c59412",
    size: 3104428,
  },
  {
    name: "jq",
    digest: "edb1cf0bbcf663d177916592d2f1b4361a02966dbf2eb44e3e61ea2a399bb43a",
    size: 716972,
  },
];

export const publishedInterpreterFile = {
  path: "/tmp/installed-script",
  content:
    '#!/opt/cirro/bin/sh\nread line; printf "%s|%s|%s|%s\\n" "$0" "$1" "$CIRRO_MARKER" "$line"; printf "%s" "$CIRRO_MARKER" > /tmp/from-script',
  encoding: "utf8",
} as const;

export const publishedInterpreterCases = [
  {
    id: "shebang-direct",
    command: "/tmp/installed-script",
    args: ["a b"],
    stdout: "/tmp/installed-script|a b|shebang-direct|input line\n",
  },
  {
    id: "shebang-spawn",
    command: "sh",
    args: ["-c", "/tmp/installed-script 'a b'; printf after"],
    stdout: "/tmp/installed-script|a b|shebang-spawn|input line\nafter",
  },
  {
    id: "shebang-exec",
    command: "sh",
    args: ["-c", "exec /tmp/installed-script 'a b'"],
    stdout: "/tmp/installed-script|a b|shebang-exec|input line\n",
  },
];

export const publishedShellCases = [
  { source: "for x in one two; do echo $x; done", stdout: "one\ntwo\n" },
  { source: "f() { echo function; }; if true; then f; fi", stdout: "function\n" },
  {
    source: 'x=0; while [ "$x" -lt 3 ]; do echo "$x"; x=$((x+1)); done',
    stdout: "0\n1\n2\n",
  },
  {
    source: 'x=; echo "${x:-default}"; case abc in a*) echo matched;; esac',
    stdout: "default\nmatched\n",
  },
  { source: "umask 077; echo private > /tmp/private; umask", stdout: "0077\n" },
  { source: "umask", stdout: "0022\n" },
  { source: "umask 077; sh -c umask; umask", stdout: "0077\n0077\n" },
  { source: "umask 077; sh -c 'umask 022'; umask", stdout: "0077\n" },
  { source: "umask 077; exec sh -c umask", stdout: "0077\n" },
  { source: `echo '{"value":42}' | jq .value`, stdout: "42\n" },
  { source: `answer=$(jq -n '21*2'); echo "$answer"`, stdout: "42\n" },
  { source: `jq .value <<'JSON'\n{"value":73}\nJSON`, stdout: "73\n" },
  {
    source: `printf 'first\\nsecond\\n' | while read line; do echo "$line"; done`,
    stdout: "first\nsecond\n",
  },
  {
    source: `sh -c 'printf out; printf err >&2' > /tmp/composed 2>&1; jq -Rs . /tmp/composed`,
    stdout: '\"outerr\"\n',
  },
  { source: "jq -n 1", stdout: "1\n" },
  { source: "jq -n 1; jq -n 2; jq -n 3", stdout: "1\n2\n3\n" },
  { source: "sh -c true; sh -c true; sh -c true", stdout: "" },
];
