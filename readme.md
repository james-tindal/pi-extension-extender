# pi-extension-extender

Modify installed Pi packages and have upstream updates merged automatically.

## Usage

1. Install: `pi install pi-extension-extender`.
2. Add your override
    * Inside Pi, run `/extension-extender add <git|npm:source>`.
    * Outside Pi, run `npx pi-extension-extender add <git|npm:source>`.
3. Make your changes in the folder reported by step 2.
