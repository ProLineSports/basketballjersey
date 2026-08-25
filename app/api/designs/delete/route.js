import { NextResponse } from "next/server";
import { DESIGN_BUCKET, errorResponse, parseDesignId, requireOwnedDesign, requireProLineUser } from "@/lib/saved-designs";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    const { id: rawId } = await request.json();
    const { userId, supabase } = await requireProLineUser();
    const id = parseDesignId(rawId);
    const design = await requireOwnedDesign(supabase, userId, id, "id,asset_paths,thumbnail_path");
    const candidates = [...new Set([...(design.asset_paths || []), design.thumbnail_path].filter(Boolean))];

    const { error: deleteError } = await supabase.from("saved_designs").delete().eq("id", id).eq("user_id", userId);
    if (deleteError) throw deleteError;

    if (candidates.length) {
      const { data: remaining, error } = await supabase.from("saved_designs")
        .select("asset_paths,thumbnail_path").eq("user_id", userId);
      if (error) throw error;
      const referenced = new Set((remaining || []).flatMap((row) => [...(row.asset_paths || []), row.thumbnail_path].filter(Boolean)));
      const unreferenced = candidates.filter((path) => !referenced.has(path));
      if (unreferenced.length) {
        const { error: storageError } = await supabase.storage.from(DESIGN_BUCKET).remove(unreferenced);
        if (storageError) console.error("Design deleted, but unreferenced asset cleanup failed", storageError);
      }
    }

    return NextResponse.json({ deleted: true, id });
  } catch (error) {
    return errorResponse(error);
  }
}
