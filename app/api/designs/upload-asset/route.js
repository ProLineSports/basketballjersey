import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  ALLOWED_IMAGE_TYPES, ApiError, DESIGN_BUCKET, MAX_FILE_BYTES, errorResponse,
  parseDesignId, requireOwnedDesign, requireProLineUser,
} from "@/lib/saved-designs";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    const { userId, supabase } = await requireProLineUser();
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
    return NextResponse.json({ path, url: signed.signedUrl, expiresIn: 3600 }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
