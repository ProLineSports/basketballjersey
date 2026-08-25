import { NextResponse } from "next/server";
import { dbConflict, errorResponse, parseDesignId, parseName, requireOwnedDesign, requireProLineUser } from "@/lib/saved-designs";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    const body = await request.json();
    const { userId, supabase } = await requireProLineUser();
    const id = parseDesignId(body.id);
    await requireOwnedDesign(supabase, userId, id, "id");
    const { data, error } = await supabase.from("saved_designs").update({ name: parseName(body.name) })
      .eq("id", id).eq("user_id", userId).select("id,name,updated_at").single();
    if (error) dbConflict(error);
    return NextResponse.json({ design: data });
  } catch (error) {
    return errorResponse(error);
  }
}
