// We don't want to add the entire CLI and its dep tree as a dependency of this plugin just for the
// purpose of having its types

// Direct this to where your own cloned copy of https://github.com/NativeScript/nativescript-cli if
// you want global types types from nativescript-cli picked up and suggestions for paths to exported
// types from rest of the CLI modules that you can use in JSDocs

// Ensure jsconfig isnt configured with "includes" key, otherwise VS Code wont pull in everything
// from the dirs under the root one referenced here

/// <reference path="../../../nativescript-cli/lib/.d.ts" />
