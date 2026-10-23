/**
 * Earth Engine expressions for the REST API (https://developers.google.com/earth-engine/reference/rest/v1/Expression):
 * a graph of function calls on constants, which `maps.create`, `value:compute` and `image:computePixels` evaluate on
 * Google's side. The builders below write the nodes; `toExpression` turns the tree into the wire form, hoisting every
 * subtree used more than once into `values` under a reference so a probability stack read three times is sent once.
 *
 * Function names are Earth Engine's own ("Image.reduce", "ImageCollection.mosaic"), with the argument names its
 * function table uses (Image.select takes `input` and `bandSelectors`; Image.eq takes `image1` and `image2`).
 */

export type EeNode =
  | { constantValue: unknown }
  | { functionInvocationValue: { functionName: string; arguments: Record<string, EeNode> } }
  | { valueReference: string }
  | { arrayValue: { values: EeNode[] } };

export type EeExpression = { result: string; values: Record<string, EeNode> };

export const constant = (value: unknown): EeNode => ({ constantValue: value });

/** One call; arguments that are not nodes become constants, undefined ones are left out. */
export function call(functionName: string, args: Record<string, unknown> = {}): EeNode {
  const out: Record<string, EeNode> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue;
    out[k] = isNode(v) ? v : constant(v);
  }
  return { functionInvocationValue: { functionName, arguments: out } };
}

function isNode(v: unknown): v is EeNode {
  return (
    !!v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    ("constantValue" in v || "functionInvocationValue" in v || "valueReference" in v || "arrayValue" in v)
  );
}

// ---- Images and collections ----

export const loadCollection = (id: string) => call("ImageCollection.load", { id });
export const mosaic = (collection: EeNode) => call("ImageCollection.mosaic", { collection });
/** A constant image: one band per value. */
export const constantImage = (value: number | number[]) => call("Image.constant", { value });
export const select = (input: EeNode, bands: string[], newNames?: string[]) =>
  call("Image.select", { input, bandSelectors: bands, ...(newNames && { newNames }) });
export const rename = (input: EeNode, names: string[]) => call("Image.rename", { input, names });
export const addBands = (dstImg: EeNode, srcImg: EeNode) => call("Image.addBands", { dstImg, srcImg });
/** Reduces an image's bands to one per pixel ("sum", "max", "min", "mean"). */
export const reduceBands = (image: EeNode, reducer: "sum" | "max" | "min" | "mean") => call("Image.reduce", { image, reducer: call(`Reducer.${reducer}`) });

type Operand = EeNode | number;
const img = (v: Operand): EeNode => (typeof v === "number" ? constantImage(v) : v);
const binary = (name: string) => (a: Operand, b: Operand) => call(`Image.${name}`, { image1: img(a), image2: img(b) });
export const add = binary("add");
export const subtract = binary("subtract");
export const multiply = binary("multiply");
export const divide = binary("divide");
export const max = binary("max");
export const eq = binary("eq");
export const neq = binary("neq");
export const gte = binary("gte");
export const lte = binary("lte");
export const and = binary("and");
export const or = binary("or");

export const updateMask = (image: EeNode, mask: EeNode) => call("Image.updateMask", { image, mask });
/** Sets every masked pixel to `value` and unmasks it. */
export const unmask = (input: EeNode, value: number) => call("Image.unmask", { input, value: constantImage(value) });
export const toFloat = (value: EeNode) => call("Image.toFloat", { value });
export const pixelArea = () => call("Image.pixelArea");
/** An 8-bit RGB picture of `image`: one band through `palette` (hex without #) from `min` to `max`. */
export const visualize = (image: EeNode, opts: { min: number; max: number; palette: string[] }) =>
  call("Image.visualize", { image, min: opts.min, max: opts.max, palette: opts.palette.map((c) => c.replace(/^#/, "")) });

// ---- Geometry and region reductions ----

export const point = (lon: number, lat: number) => call("GeometryConstructors.Point", { coordinates: [lon, lat] });
/** A box in lon/lat (planar edges, as the map draws them). */
export const rectangle = ([w, s, e, n]: [number, number, number, number]) =>
  call("GeometryConstructors.Polygon", { coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]], geodesic: false });

/** Reduces an image over a region to a dictionary of band values. `bestEffort` lets Earth Engine coarsen the scale to fit `maxPixels`. */
export function reduceRegion(
  image: EeNode,
  geometry: EeNode,
  reducer: "first" | "sum" | "mean" | "max" | "frequencyHistogram",
  opts: { scale: number; maxPixels?: number; bestEffort?: boolean; tileScale?: number },
): EeNode {
  return call("Image.reduceRegion", {
    image,
    reducer: call(`Reducer.${reducer}`),
    geometry,
    scale: opts.scale,
    ...(opts.maxPixels !== undefined && { maxPixels: opts.maxPixels }),
    ...(opts.bestEffort !== undefined && { bestEffort: opts.bestEffort }),
    ...(opts.tileScale !== undefined && { tileScale: opts.tileScale }),
  });
}

// ---- Serialisation ----

/**
 * The wire form of a tree: `values["0"]` is the root, and every subtree that appears more than once (a function call,
 * by its JSON) is hoisted under its own key and referenced, so the request carries it once.
 */
export function toExpression(root: EeNode): EeExpression {
  const counts = new Map<string, number>();
  const count = (node: EeNode): string => {
    const key = JSON.stringify(node);
    if ("functionInvocationValue" in node) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if ((counts.get(key) ?? 0) === 1) for (const child of Object.values(node.functionInvocationValue.arguments)) count(child);
    } else if ("arrayValue" in node) {
      for (const child of node.arrayValue.values) count(child);
    }
    return key;
  };
  count(root);

  const values: Record<string, EeNode> = {};
  const refs = new Map<string, string>();
  let next = 1;
  const emit = (node: EeNode, isRoot = false): EeNode => {
    if ("functionInvocationValue" in node) {
      const key = JSON.stringify(node);
      const shared = !isRoot && (counts.get(key) ?? 0) > 1;
      if (shared && refs.has(key)) return { valueReference: refs.get(key) as string };
      const args: Record<string, EeNode> = {};
      for (const [k, v] of Object.entries(node.functionInvocationValue.arguments)) args[k] = emit(v);
      const out: EeNode = { functionInvocationValue: { functionName: node.functionInvocationValue.functionName, arguments: args } };
      if (!shared) return out;
      const ref = String(next++);
      refs.set(key, ref);
      values[ref] = out;
      return { valueReference: ref };
    }
    if ("arrayValue" in node) return { arrayValue: { values: node.arrayValue.values.map((v) => emit(v)) } };
    return node;
  };
  values["0"] = emit(root, true);
  return { result: "0", values };
}
