import { NextResponse } from "next/server";
import {
  ApiError, dbConflict, errorResponse, parseAssetPaths, parseBuilderType, parseDesignData,
  parseDesignId, parseName, requireOwnedDesign, requireProLineUser,
} from "@/lib/saved-designs";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    const body = await request.json();
    const { userId, email, saveLimit, plan, supabase } = await requireProLineUser();
    const builderType = parseBuilderType(body.builderType);
    const name = parseName(body.name);
    const designData = parseDesignData(body.designData);
    const assetPaths = parseAssetPaths(body.assetPaths, userId);
    const thumbnailPath = body.thumbnailPath ? parseAssetPaths([body.thumbnailPath], userId)[0] : null;

    if (body.id) {
      const id = parseDesignId(body.id);
      await requireOwnedDesign(supabase, userId, id, "id,builder_type");
      const { data, error } = await supabase
        .from("saved_designs")
        .update({ name, builder_type: builderType, design_data: designData, asset_paths: assetPaths, thumbnail_path: thumbnailPath })
        .eq("id", id)
        .eq("user_id", userId)
        .select("id,name,builder_type,asset_paths,thumbnail_path,created_at,updated_at")
        .single();
      if (error) dbConflict(error);
      return NextResponse.json({ design: data, limit: saveLimit, plan });
    }

    const { count, error: countError } = await supabase
      .from("saved_designs")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId);
    if (countError) throw countError;
    if ((count || 0) >= saveLimit) {
      throw new ApiError(403, `Your account can save up to ${saveLimit} designs.`, "SAVE_LIMIT_REACHED");
    }

    const { data, error } = await supabase
      .from("saved_designs")
      .insert({ user_id: userId, email, builder_type: builderType, name, design_data: designData, asset_paths: assetPaths, thumbnail_path: thumbnailPath })
      .select("id,name,builder_type,asset_paths,thumbnail_path,created_at,updated_at")
      .single();
    if (error) dbConflict(error);
    return NextResponse.json({ design: data, limit: saveLimit, plan }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
