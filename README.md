# Figma to Fusion

Send a Figma frame, or any selection of layers, into a DaVinci Resolve Fusion composition as a clean, vertical node tree. Every element is placed pixel perfect, using Fusion's 0 to 1 coordinate space, and stays editable: shapes become Background and mask nodes, text becomes Text+, everything else travels as a PNG on a Loader.

Only standard Fusion nodes are used (Loader, Background, Rectangle / Ellipse / Polygon masks, sRectangle / sEllipse / sRender, Text+, Merge, Transform, Shadow, Blur). Nothing extra to install inside Resolve.

## What you need

- Windows 10 or 11
- The **Figma desktop app** (development plugins do not run in the browser version)
- **DaVinci Resolve** 18 or later. The free version works with copy and paste. **Resolve Studio** can also receive the nodes directly, with no paste.

## Install

### 1. The companion app

1. Go to the [Releases](../../releases) page and download `Figma to Fusion Setup <version>.exe`.
2. Run it. Windows can show "Windows protected your PC" because the installer is not code signed. Click **More info**, then **Run anyway**.
3. The app has no window. It runs in the system tray, near the clock. The Figma plugin talks to it on `localhost:7421`; nothing leaves your computer.

From the tray menu you can open or change the export folder (default: `Documents\FigmaToFusion`), turn on "Start with Windows", and turn notifications on or off.

### 2. The Figma plugin

1. From the same release, download `figma-to-fusion-plugin.zip` and unzip it anywhere you will keep it (Figma loads the plugin from that folder).
2. In the Figma desktop app, open any design file.
3. Menu > **Plugins > Development > Import plugin from manifest...** and pick `manifest.json` inside the unzipped folder.
4. Run it from **Plugins > Development > Figma to Fusion**.

The status line at the bottom of the plugin shows whether it can see the companion app.

## Use

1. In Figma, select a frame (the whole frame is sent) or some layers inside a frame (only those, kept in position).
2. Click **Send to Fusion**.
3. In Resolve, open the Fusion page, click in the node editor and press **Ctrl+V**.

That is it. The nodes land in a vertical tree, one branch per element, sized for the frame.

### Skip the paste (Resolve Studio)

1. In Resolve: **Preferences > System > General > External scripting using** set to **Local**.
2. Open a Fusion composition.
3. In the plugin, **Deliver > Deliver by > Paste into Resolve**.

Now **Send to Fusion** puts the nodes straight into the open comp.

## The three tabs

- **Source**: what is selected, a preview of the node tree, and what travels as one element. Click a group in the preview to send it as one element (click again to split it). The choice is saved on the Figma layer.
- **Build**: how each kind of layer becomes nodes.
  - Shapes: **PNG** (rendered by Figma, closest match) or **Fusion nodes** (editable Background + mask nodes, or Shape nodes).
  - Text: **Text+** (editable, needs the fonts installed on this computer) or **PNG**.
  - PNG: export scale, and sharper small elements.
- **Deliver**: clipboard or direct paste, comp size, and a Transform node per element.

### Control it from layer names

- `*Name`: always send this group as one element.
- `+Name`: always split this group into its layers.
- `-Name`: leave this layer out.

The symbol is dropped from the Fusion node name.

## What becomes native nodes

| Figma | Fusion |
|---|---|
| Rectangle or frame background, one corner radius | Background + RectangleMask |
| Ellipse | Background + EllipseMask |
| Any other vector, star, polygon, boolean | Background + Polygon masks (holes are Subtract masks) |
| Solid, linear and radial gradient fills | Background color or gradient |
| Strokes | Mask border, or outlined stroke polygons |
| One drop shadow | Shadow tool |
| Layer blur | Blur tool |
| Opacity and blend mode | Merge Blend and Apply Mode |
| Text (also rotated, gradient filled, auto wrapped) | Text+ |

Anything Fusion cannot rebuild exactly (inner shadows, background blur, image fills, angular gradients, and so on) stays a PNG, and the plugin lists the reason under "notes about this send".

## How it stays pixel perfect

Fusion places everything in normalized coordinates: 0 to 1 across the comp, with Y going up. A 1920 x 1080 comp and a 3840 x 2160 comp use the same numbers. The converter maps every Figma pixel position into that space, and the factors Fusion uses for text size, blur, shadow softness and mask sizes were measured inside Resolve and are built into `core/src/build.ts`.

Mixed text styles in one text layer come across with the main style only (Text+ keeps one style per node), and the plugin says so.

## Build from source

Needs Node.js 20 or later.

```bash
npm install
npm run build:plugin   # plugin/dist, then import plugin/manifest.json in Figma
npm run dist           # release/Figma to Fusion Setup <version>.exe
npm test
```

`npm run app` runs the tray app without installing it. `npm run companion` runs the same server in a terminal.

```
plugin/     Figma plugin: reads the selection, exports PNGs, sends everything to the companion
companion/  tray app + localhost:7421 server: writes PNGs, builds the node text, copies or pastes it
core/       converter: scene JSON to Fusion node text (coordinates, layout, serializer)
```

## Troubleshooting

- **Plugin says the companion is offline**: check the tray icon. Start "Figma to Fusion" from the Start menu.
- **Fonts look different**: install the same fonts on the computer that runs Resolve, or switch Text to PNG.
- **Text+ position is off in a comp of another size**: set Comp size under Deliver to your Fusion comp size.
- **Paste into Resolve fails**: it needs Resolve Studio, External scripting set to Local, and a Fusion comp open.
