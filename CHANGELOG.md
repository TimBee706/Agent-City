# Changelog

## 0.2.0

A smoother, livelier and much cheaper city.

### Look

- Soft gradients instead of flat fills on walls, roofs, windows, trees, water and the rug; softer outlines, cast shadows and
  a bright edge where two walls meet. The noisy grass / park textures are gone.
- Houses got glazing bars, a door with a window, knob and awning, roof tiles with a ridge, and antennas with a beacon on tall
  office blocks; name plates are rounded pills.
- A real sky behind the city: gradient by time of day, sun or moon, stars at night.
- Night lighting: darker walls and trees, glowing windows, light pools in front of lit houses and under street lamps, car
  headlights.
- Building view: lit rooms with ceiling lamps, window sills, plants, wooden floors, a shingled roof with chimney, a nicer
  lobby and a basement lamp.

### Animations

- Smooth camera flights for the zoom buttons, the keyboard, fit, the taxi, focus requests and the minimap.
- Ambient life (new setting `claudeCity.ambient.effects`): clouds, birds, chimney smoke on busy houses, fountain jets.
- A pulsing ring around every "!" that waits for you, a bouncing pin over the selected building, fireworks over a building
  when a task completes, bobbing subagents on their way to the door.
- The elevator in the building view travels between the lobby and the top floor.

### Features

- Minimap for cities with 6+ buildings: dots coloured by urgency, a frame for the current view, click or drag to navigate.
- New command **Go to Next Session That Needs Attention** (also `N` on the map): opens the city and flies to the next
  building with a waiting, failed or working session.

### Performance

- The city is split into four camera layers (ground, cars, buildings, effects). Panning moves them on the GPU instead of
  redrawing the scene; a moving car or a puff of smoke no longer forces the browser to re-layer the whole city.
- No continuous animations in the static layers; traffic lights, window flicker and beacons are driven by one slow clock.
- Effects are culled to the buildings in view; more level-of-detail steps when zoomed out.
- The "needs your attention" button in the HUD no longer animates `box-shadow` (it caused a style recalculation and repaint
  on every frame for as long as something was waiting).
- With 150 buildings (see README, *Performance*): idle main-thread time down by about 90 %, panning and zooming by about 60-70 %.

### Fixes

- Fast repeated clicks on the zoom buttons now add up instead of restarting from the current position.

## 0.1.0

First version.

- City visualization of local Claude Code sessions and agents (activity bar overview, city panel, building view).
- Live data via `claude agents --json --all`, optional live events through loopback-only Claude Code HTTP hooks.
- Past sessions imported read-only from local transcripts (recent rooms, archived basement boxes).
- Workspace import from folders, demo mode, light/dark/high-contrast themes, reduced motion, keyboard navigation.
