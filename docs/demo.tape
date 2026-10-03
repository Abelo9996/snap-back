# Terminal demo for the README. Render from the repository root after `npm run build`:
#   vhs docs/demo.tape
# Runs in a throwaway project under /tmp with a scripted stand-in for an agent.

Output docs/demo.gif

Set Shell "bash"
Set FontSize 18
Set Width 1240
Set Height 700
Set Padding 16
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms
Set Framerate 12

Hide
Type `export BASH_SILENCE_DEPRECATION_WARNING=1 PS1='$ ' SB="node $PWD/dist/cli.js"` Enter
Type `alias snap-back="$SB"` Enter
Type `D=/tmp/snap-back-demo && rm -rf $D && mkdir -p $D/home $D/bin $D/my-app/src $D/my-app/test` Enter
Type `export HOME=$D/home SNAP_BACK_HOME=$D/store PATH="$D/bin:$PATH" && cd $D/my-app && git init -q` Enter
Type `printf 'import { slugify } from "./utils.js";\nconsole.log(slugify("Hello World"));\n' > src/app.js` Enter
Type `printf 'export const slugify = (s) => s.toLowerCase().replace(/ +/g, "-");\n' > src/utils.js` Enter
Type `printf 'import { slugify } from "../src/utils.js";\n' > test/utils.test.js && echo "# my-app" > README.md` Enter
Type `printf '%s\n' '#!/bin/sh' 'echo "agent: removing dead code"; sleep 0.8' 'echo "agent: deleting src/utils.js"; rm src/utils.js; sleep 0.5' 'echo "agent: deleting test/utils.test.js"; rm test/utils.test.js; sleep 0.5' 'echo "agent: rewriting src/app.js"; echo "console.log(1);" > src/app.js; sleep 0.3' > $D/bin/agent && chmod +x $D/bin/agent` Enter
Type `clear` Enter
Sleep 1s
Show

Type "find src test -type f"
Sleep 400ms
Enter
Sleep 1.2s
Type `snap-back wrap -- agent "clean up the codebase"`
Sleep 600ms
Enter
Sleep 4s
Type "find src test -type f"
Sleep 400ms
Enter
Sleep 1.5s
Type "snap-back undo"
Sleep 600ms
Enter
Sleep 2s
Type "y"
Sleep 400ms
Enter
Sleep 2s
Type "find src test -type f"
Sleep 400ms
Enter
Sleep 4s
