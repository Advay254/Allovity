# Brand assets (placeholders)

Everything in this folder is a placeholder. It is not the official Allovity brand and must not be described as such.

| File                    | Purpose                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| `symbol.svg`            | Abstract symbol: a forward chevron built from two modules, plus one detached module. Flat colour, no gradients. |
| `wordmark-on-light.svg` | Symbol and wordmark for light backgrounds. Text is converted to paths, so it needs no font.                     |
| `app-icon.svg`          | White symbol on a flat brand blue square. Source for the app icons.                                             |
| `og-image.svg`          | 1200 by 630 social sharing image on the light background. Source for the PNG.                                   |

The build (`npm run build:assets`) turns these into the favicon, PNG app icons and the social image. No binary files are stored in the repository.

## How to replace them

1. Replace the SVG files here with the official artwork, keeping the same file names.
2. Keep `symbol.svg` and `app-icon.svg` square (viewBox 0 0 32 32 and 0 0 512 512 respectively) and `og-image.svg` at 1200 by 630.
3. Commit. The next deploy rebuilds every derived icon and image.

The header and footer show the symbol through `views/partials/symbol.ejs`. Update the shapes there if the symbol changes.
