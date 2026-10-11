/**
 * The owner's two Tierra del Fuego answers (southern Patagonia, a view of about 70,000 km², no place named), as the
 * message parts the chat received: the note's markdown and the closing text that repeated it. Reconstructed from the
 * owner's report of the transcript; the structure (duplicated headings, conflicting year ranges, "Sources" inside the
 * text) is what the tests rely on.
 */
import type { DedupePart } from "@/lib/agent/dedupe";

/** "great hikes around here": osm-trails hit its area cap, and both the note and the text lectured about zooming in. */
export const HIKES_NOTE = `**Trails need a closer view**

The current view covers about 70,000 km², but the hiking trails layer (osm-trails) only works for areas under 2,500 km². I could not load trails for this whole region of Tierra del Fuego.

**Next steps**
- Zoom in to around zoom 9 over the area you care about, such as the Fuegian Andes near Ushuaia.
- Or name a place, for example Tierra del Fuego National Park, and I will look it up.

**Sources**
OpenStreetMap contributors (ODbL).`;

export const HIKES_TEXT = `The current view of southern Patagonia covers about 70,000 km², which is larger than the 2,500 km² limit of the hiking trails layer, so I could not load trails for this whole region.

**Next steps**
To find great hikes, zoom in to around zoom 9 over the part of Tierra del Fuego you care about, or name a place such as Ushuaia or Tierra del Fuego National Park and I will look up trails there.

**Follow-up questions**
- Would you like me to look up trails in Tierra del Fuego National Park?
- Should I show peaks and viewpoints across this region instead?
- Do you want campsites near Ushuaia?

**Sources**
OpenStreetMap contributors (ODbL).`;

export const HIKES_PARTS: DedupePart[] = [
  {
    type: "tool-query_osm-trails",
    state: "output-available",
    output: { error: "Area is 70412 km²; zoom in to under 2500 km²", hint: "zoom_in", suggestedZoom: 9 },
  },
  { type: "tool-note", state: "output-available", output: { markdown: HIKES_NOTE } },
  { type: "text", text: HIKES_TEXT, state: "done" },
];

/** "deforestation or water rise in this area": forest-loss and flood-extent drawn, then about 400 words said twice. */
export const WATER_NOTE = `**Forest loss and surface water across southern Patagonia**

The map shows tree cover loss (pink) from 2001–2025 and open water from the latest satellite pass (blue).

- **Forest loss:** scattered pink patches along the southern beech forests north of the Beagle Channel and around Lago Fagnano, mostly small clearings and the edges of old burns. Most loss sits close to roads and settlements.
- **Water:** large areas of blue across the fjords, Lago Fagnano and the channels between the islands, suggesting recent flooding or melt-water rise along the coast.

**Coverage notes**
- Loss is any canopy removal (logging, fire, storms, beaver damage), not only deforestation.
- Clouds hide much of the region on most days, so water may be under-counted.

**Next steps**
- Compare forest loss between 2015 and 2025 to see the trend.
- Zoom in on Lago Fagnano to see the shoreline in detail.

**Sources**
Hansen/UMD/Google/USGS/NASA via Global Forest Watch; NASA OPERA surface water extent.`;

export const WATER_TEXT = `**Forest loss and water in southern Patagonia**

I drew tree cover loss for 2015–2025 and the newest open-water map for this view of Tierra del Fuego.

Forest loss shows as scattered pink patches in the southern beech forests north of the Beagle Channel and around Lago Fagnano, mostly small clearings close to roads and settlements and the edges of old burns.

The water layer shows large areas of blue across the fjords, Lago Fagnano and the channels between the islands, which suggests recent flooding or melt-water rise along the coast.

**Coverage notes**
Loss is any canopy removal (logging, fire, storms, beaver damage), not only deforestation. Clouds hide much of the region on most days, so water may be under-counted.

**Next steps**
- Compare forest loss between 2015 and 2025 to see the trend.
- Zoom in on Lago Fagnano to see the shoreline in detail.

**Sources**
Hansen/UMD/Google/USGS/NASA via Global Forest Watch; NASA OPERA surface water extent.

Would you like to explore further?
- Should I compare forest loss in 2015 and 2025?
- Do you want to see where water has been lost or gained since 1984?
- Should I zoom in on Lago Fagnano?`;

export const WATER_PARTS: DedupePart[] = [
  { type: "tool-query_forest-loss", state: "output-available", output: { kind: "tiles" } },
  { type: "tool-query_flood-extent", state: "output-available", output: { kind: "tiles" } },
  { type: "tool-render", state: "output-available", output: { layerId: "forest-loss" } },
  { type: "tool-render", state: "output-available", output: { layerId: "flood-extent" } },
  { type: "tool-note", state: "output-available", output: { markdown: WATER_NOTE } },
  { type: "text", text: WATER_TEXT, state: "done" },
];
