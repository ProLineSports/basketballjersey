import "server-only";
import { auth, currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const DESIGN_BUCKET = "design-assets";
export const BUILDER_TYPES = new Set(["helmet"]); // Add future builder slugs here.
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const ALLOWED_IMAGE_TYPES = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
]);

export class ApiError extends Error {
  constructor(status, message, code = "REQUEST_FAILED") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function errorResponse(error) {
  if (error instanceof ApiError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
  console.error("Saved designs API error", error);
  return NextResponse.json(
    { error: "Something went wrong. Please try again.", code: "INTERNAL_ERROR" },
    { status: 500 },
  );
}

export async function requireProLineUser() {
  const { userId } = await auth();
  if (!userId) throw new ApiError(401, "Sign in to manage saved designs.", "UNAUTHENTICATED");

  const supabase = getSupabaseAdmin();
  const { data: account, error } = await supabase
    .from("users")
    .select("email, paid_credits, is_unlimited, lifetime_all_access")
    .eq("id", userId)
    .maybeSingle();

  if (error) throw error;

  let email = account?.email || null;
  if (!email) {
    const clerkUser = await currentUser();
    email = clerkUser?.primaryEmailAddress?.emailAddress || null;
  }

  const isLifetime = account?.lifetime_all_access === true;
  const isUnlimited = account?.is_unlimited === true;
  const hasPaidCredits = Number(account?.paid_credits || 0) > 0;
  const saveLimit = isLifetime || isUnlimited ? 50 : hasPaidCredits ? 10 : 3;
  const plan = isLifetime ? "lifetime" : isUnlimited ? "unlimited" : hasPaidCredits ? "paid_credits" : "free";

  return { userId, email, saveLimit, plan, supabase };
}

export function parseBuilderType(value) {
  const builderType = String(value || "helmet").trim().toLowerCase();
  if (!BUILDER_TYPES.has(builderType)) {
    throw new ApiError(400, "Unsupported builder type.", "INVALID_BUILDER_TYPE");
  }
  return builderType;
}

export function parseDesignId(value) {
  const id = String(value || "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new ApiError(400, "A valid design id is required.", "INVALID_DESIGN_ID");
  }
  return id;
}

export function parseName(value) {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  if (!name || name.length > 80) {
    throw new ApiError(400, "Design names must be 1–80 characters.", "INVALID_NAME");
  }
  return name;
}

export function parseDesignData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "designData must be a JSON object.", "INVALID_DESIGN_DATA");
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 1024 * 1024) {
    throw new ApiError(413, "Design data is too large.", "DESIGN_DATA_TOO_LARGE");
  }
  return value;
}

export function parseAssetPaths(value, userId) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 30) {
    throw new ApiError(400, "assetPaths must contain at most 30 paths.", "INVALID_ASSET_PATHS");
  }
  const prefix = `${userId}/`;
  const paths = [...new Set(value.map(String))];
  if (paths.some((path) => !path.startsWith(prefix) || path.includes(".."))) {
    throw new ApiError(403, "One or more assets do not belong to this account.", "INVALID_ASSET_OWNER");
  }
  return paths;
}

export async function requireOwnedDesign(supabase, userId, id, columns = "*") {
  const { data, error } = await supabase
    .from("saved_designs")
    .select(columns)
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ApiError(404, "Design not found.", "DESIGN_NOT_FOUND");
  return data;
}

export async function signedAssetMap(supabase, paths, expiresIn = 3600) {
  if (!paths.length) return {};
  const { data, error } = await supabase.storage.from(DESIGN_BUCKET).createSignedUrls(paths, expiresIn);
  if (error) throw error;
  return Object.fromEntries((data || []).filter((item) => item.signedUrl).map((item) => [item.path, item.signedUrl]));
}

export function dbConflict(error) {
  if (error?.code === "23505") {
    throw new ApiError(409, "A design with that name already exists.", "DUPLICATE_NAME");
  }
  throw error;
}
