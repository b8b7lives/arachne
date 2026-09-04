# Contributing

## Building and testing

The README's Building it and Testing sections cover setup, and
`./verify.sh` runs every check the project relies on.

## Pull requests

Development happens outside this mirror, which carries one commit per
published build, so a pull request has no branch to merge into. You
are welcome to send one anyway or to attach a patch to an issue. It
will be read, and if it fits it will be carried into the next build
with credit.

## Bugs and ideas

The issue templates ask for what is needed. A bug report is most useful
with the build id from the page footer and the picture or settings that
reproduce it. An idea is most useful when it says what you are trying
to build and where the tool gets in the way.

## Rules for changes

- Game facts such as block colors, tool speeds, and map shading come
  from the game's own files, never from memory. The data pipeline
  README explains how they are read.
- Blocks are curated in the data pipeline, never in the UI.
- Code carries no comments. Documentation lives in the README and in
  the data pipeline README.
- The core stays pure, with no I/O in compute paths, and the wasm
  boundary stays thin.
- The web app has no runtime npm dependencies. Development
  dependencies are fine.
- Nothing that ships may include tracking, analytics, third-party
  origins, or personal data of any kind.
- Visitor-facing text uses American spelling and avoids em and en
  dashes.
- Everything is licensed GPL-3.0.
