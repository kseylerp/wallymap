"use client";

import { MapCanvas } from "@/components/MapCanvas";
import { initialMapState } from "@/lib/render/state";

// Temporary page for the map canvas check; Task 9 replaces it with the chat + map layout.
export default function Home() {
  return (
    <main className="h-screen w-full">
      <MapCanvas state={initialMapState} onViewportChange={() => {}} />
    </main>
  );
}
