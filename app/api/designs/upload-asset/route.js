import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  ALLOWED_IMAGE_TYPES, ApiError, DESIGN_BUCKET, MAX_FILE_BYTES, errorResponse,
  getAssetLimitBytes, parseAssetPaths, parseDesignId, requireOwnedDesign, requireProLineUser,
} from "@/lib/saved-designs";

export const runtime = "nodejs";

async function getUserAssetUsageBytes(supabase, userId) {
  const storage = supabase.storage.from(DESIGN_BUCKET);
  const { data: rootEntries, error: rootError } = await storage.list(userId, {
    limit: 1000,
    sortBy: { column: "name", order: "asc" },
  });
  if (rootError) throw rootError;

  let total = 0;
  for (const entry of rootEntries || []) {
    if (entry.metadata?.size != null) {
      total += Number(entry.metadata.size) || 0;
      continue;
    }

    const { data: files, error } = await storage.list(`${userId}/${entry.name}`, {
      limit: 1000,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) throw error;
    total += (files || []).reduce((sum, file) => sum + (Number(file.metadata?.size) || 0), 0);
  }
  return total;
}

function formatMegabytes(bytes) {
  return Math.max(1, Math.round(bytes / (1024 * 1024)));
}

export async function POST(request) {
  try {
    const { userId, plan, supabase } = await requireProLineUser();
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new ApiError(400, "Choose an image to upload.", "FILE_REQUIRED");
    const extension = ALLOWED_IMAGE_TYPES.get(file.type);
    if (!extension) throw new ApiError(415, "Use a PNG, JPEG, or WebP image.", "UNSUPPORTED_FILE_TYPE");
    if (file.size <= 0 || file.size > MAX_FILE_BYTES) {
      throw new ApiError(413, "Images must be 10 MB or smaller.", "FILE_TOO_LARGE");
    }

    const rawDesignId = form.get("designId");
    const folder = rawDesignId ? parseDesignId(rawDesignId) : "staging";
    if (rawDesignId) await requireOwnedDesign(supabase, userId, folder, "id");

    const assetLimit = getAssetLimitBytes(plan);
    const assetUsage = await getUserAssetUsageBytes(supabase, userId);
    if (assetUsage + file.size > assetLimit) {
      throw new ApiError(
        403,
        `Your ${plan.replaceAll("_", " ")} plan includes ${formatMegabytes(assetLimit)} MB of saved-design artwork. Delete an older design or use a smaller image.`,
        "ASSET_LIMIT_REACHED",
      );
    }

    const path = `${userId}/${folder}/${randomUUID()}.${extension}`;
    const bytes = Buffer.from(await file.arrayBuffer());
    const { error } = await supabase.storage.from(DESIGN_BUCKET).upload(path, bytes, {
      contentType: file.type, cacheControl: "3600", upsert: false,
    });
    if (error) throw error;
    const { data: signed, error: signError } = await supabase.storage.from(DESIGN_BUCKET).createSignedUrl(path, 3600);
    if (signError) {
      await supabase.storage.from(DESIGN_BUCKET).remove([path]);
      throw signError;
    }
    return NextResponse.json({
      path,
      url: signed.signedUrl,
      expiresIn: 3600,
      assetUsageBytes: assetUsage + file.size,
      assetLimitBytes: assetLimit,
    }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request) {
  try {
    const { path: rawPath } = await request.json();
    const { userId, supabase } = await requireProLineUser();
    const path = parseAssetPaths([rawPath], userId)[0];

    const { data: designs, error } = await supabase
      .from("saved_designs")
      .select("asset_paths,thumbnail_path")
      .eq("user_id", userId);
    if (error) throw error;

    const isReferenced = (designs || []).some((design) =>
      design.thumbnail_path === path || (design.asset_paths || []).includes(path)
    );
    if (isReferenced) {
      throw new ApiError(409, "That artwork is still used by a saved design.", "ASSET_IN_USE");
    }

    const { error: removeError } = await supabase.storage.from(DESIGN_BUCKET).remove([path]);
    if (removeError) throw removeError;
    return NextResponse.json({ deleted: true, path });
  } catch (error) {
    return errorResponse(error);
  }
}
