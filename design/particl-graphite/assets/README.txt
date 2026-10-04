assets/
  hero.webp · environment.webp · character.webp — the three sample stills every frame uses (takes, plates, cast, ads, clips). Where the originals could not be fetched at export time, a striped placeholder with the same name stands in; drop the originals over them to restore the imagery.
  Fonts: the system stack (-apple-system · SF Pro · Helvetica Neue · system-ui); no web font is loaded, so nothing is fetched.
  Icons: inline SVG in the files; none are loaded from outside.
  vendor/ — React 18.3.1, ReactDOM 18.3.1 and Babel standalone 7.29.0, loaded by support.js through window.__resources so nothing comes from unpkg.
