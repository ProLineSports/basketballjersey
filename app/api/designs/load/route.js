import { NextResponse } from "next/server";
import { errorResponse, parseDesignId, requireOwnedDesign, requireProLineUser, signedAssetMap } from "@/lib/saved-designs";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    const { id } = await request.json();
    const { userId, supabase } = await requireProLineUser();
    const design = await requireOwnedDesign(supabase, userId, parseDesignId(id));
    const paths = [...new Set([...(design.asset_paths || []), design.thumbnail_path].filter(Boolean))];
    const assetUrls = await signedAssetMap(supabase, paths);
    return NextResponse.json({ design, assetUrls, assetUrlExpiresIn: 3600 });
  } catch (error) {
    return errorResponse(error);
  }
}
