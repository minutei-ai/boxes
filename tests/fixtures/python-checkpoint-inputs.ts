import { PythonProgram } from "../../src/contracts";

export const pythonCheckpointPrograms = [
  PythonProgram.make({
    language: "python",
    env: { MODE: "first", OLD: "removed" },
    filePath: "/first.py",
    mode: "execute",
    source:
      "import os, sys, json, re, functools\nfrom collections import Counter\ncounts = Counter(\"boxes\")\nfrom _thread import RLock\nsaved_lock=RLock()\nsaved_lock.acquire()\nsaved_lock.acquire()\n@functools.lru_cache(maxsize=8)\ndef cached(value):\n return value*2\nencoded = json.dumps({\"value\":cached(21),\"text\":\"ação\"},ensure_ascii=False)\ncached_env = os.environ\nwriter = sys.stdout.write\ndef factory():\n n = 40\n def next():\n  nonlocal n\n  n += 1\n  return n\n return next\nnext_value = factory()\nreply = await tools.call({'op':'host.call','name':'echo','input':2})\nprint('first')\n[next_value(), reply, os.getenv('MODE')]",
  }),
  PythonProgram.make({
    language: "python",
    env: { MODE: "second" },
    filePath: "/second.py",
    mode: "execute",
    source:
      "writer('second\\n')\n[next_value(), cached_env.get('MODE'), cached_env.get('OLD'), next_value.__code__.co_filename, json.loads(encoded), re.findall(r'[a-z]+','box 42 native'), counts['x'], cached(21), saved_lock._recursion_count()]",
  }),
  PythonProgram.make({
    language: "python",
    env: { MODE: "third" },
    filePath: "/third.py",
    mode: "evaluate",
    source: "(saved_lock.release(),saved_lock.release(),next_value(),saved_lock.locked())[2:]",
  }),
];
