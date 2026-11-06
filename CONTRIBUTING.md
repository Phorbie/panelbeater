# Contributing

Thanks for helping. This is a small, deliberately low-maintenance project, so a few ground rules:

- **Bugs:** open an issue with the model file (or a link), the recipe JSON (**Save recipe**), and what you expected to see.
- **Features:** open an issue before writing code. Check the README's scope and "Not planned" list first.
- **Geometry (`core.js`):** keep it dependency-free and DOM-free, and add a test in `test/core.test.js`. Run `node --test`.
- **UI (`app.js`, `index.html`):** no frameworks or build tools. Check that it works at phone width and in both light and dark themes.
- **Recipes:** don't change what an existing op does to an existing recipe. Add a new op type or option instead.
