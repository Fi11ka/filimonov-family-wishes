import type { Currency } from "../../shared/price";
export interface PriceInfo {
  min: number | null; // minor units
  max: number | null;
  currency: Currency;
}
export interface ProductInfo {
  title?: string;
  /** Fallback origin disclosed to the user; original shop URL is retained. */
  source?: "aliexpress-global";
  image?: string;
  price?: PriceInfo | null;
  /** Shop answered with an anti-bot page or refused the request. */
  blocked?: boolean;
  /** Explicitly reported by the shop; missing price alone is not proof. */
  unavailable?: boolean;
}
export interface Page {
  url: URL;
  status: number;
  html: string;
}
/** Network access handed to shop modules; tests replace it with fixtures. */
export interface ShopContext {
  page(url: URL, accept?: string): Promise<Page>;
  json(url: URL, headers?: Record<string, string>): Promise<unknown>;
}
/**
 * A shop module. To support a new shop, add a file exporting a Shop and list it
 * in shops/index.ts. Anything a module does not find is filled by the generic
 * (Open Graph / schema.org) parser.
 */
export interface Shop {
  id: string;
  name: string;
  matches(url: URL): boolean;
  parse(url: URL, ctx: ShopContext): Promise<ProductInfo>;
}
