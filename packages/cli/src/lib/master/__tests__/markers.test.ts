import { describe, it, expect } from "vitest";
import { escapeForRegExp, masterMarkers } from "../markers.ts";

describe("masterMarkers — one map, resolved by language", () => {
  it("returns the Spanish marker set for 'es'", () => {
    const markers = masterMarkers("es");
    expect(markers.origen).toBe("Origen:");
    expect(markers.ninguna).toBe("Ninguna");
    expect(markers.supuesto).toBe("[SUPUESTO]");
    expect(markers.sinVerificar).toBe("[SIN VERIFICAR]");
    expect(markers.sinDecisiones).toBe("Sin decisiones");
    expect(markers.noAplica).toBe("No aplica:");
  });

  it("returns the English marker set for 'en', never mixing in a Spanish literal", () => {
    const markers = masterMarkers("en");
    expect(markers.origen).toBe("Source:");
    expect(markers.ninguna).toBe("None");
    expect(markers.supuesto).toBe("[ASSUMED]");
    expect(markers.sinVerificar).toBe("[UNVERIFIED]");
    expect(markers.sinDecisiones).toBe("No decisions");
    expect(markers.noAplica).toBe("Not applicable:");
    for (const value of Object.values(markers)) {
      expect(value).not.toMatch(/[áéíóúñ]/i);
    }
  });
});

describe("escapeForRegExp — markers with regex metacharacters", () => {
  it("escapes brackets so '[SUPUESTO]' matches itself literally", () => {
    const pattern = new RegExp(escapeForRegExp("[SUPUESTO]"));
    expect(pattern.test("texto con [SUPUESTO] adentro")).toBe(true);
    expect(pattern.test("texto sin el marcador")).toBe(false);
  });
});
