// ---------------------------------------------------------------------------
// DiDi: abrir la app (herramienta open_didi)
// ---------------------------------------------------------------------------
//
// DiDi no ofrece una API pública para pedir viajes de parte de un tercero, ni (que sepamos) un
// enlace documentado que cargue el destino en su app. Por eso el asistente NO pide ni cancela
// viajes, ni ve tarifas, el estado o el historial: solo PREPARA la salida. La app abre DiDi (o su
// ficha en Google Play si no está instalada) y deja el destino copiado para pegarlo en "¿A dónde
// vas?"; el usuario elige el viaje, ve la tarifa y lo pide él.
//
// El servidor solo valida y arma la acción. Los destinos no se guardan ni se registran en logs.

import { cleanPlaceText } from "./maps";

export interface DidiBody {
  kind: "didi_open";
  /** Dónde quiere ir; la app lo copia al portapapeles. Opcional: puede abrir DiDi sin destino. */
  destination?: string;
}

/** Destino válido o null (texto de 2 a 200 caracteres, sin saltos de línea ni caracteres de control). */
export const cleanDidiDestination = cleanPlaceText;

export function describeDidi(b: DidiBody): string {
  return b.destination
    ? `Abrir DiDi y copiar el destino "${b.destination}" para que lo pegues en "¿A dónde vas?". ` +
        "Tú eliges el viaje, ves la tarifa y lo pides: no se pide solo."
    : "Abrir DiDi. Tú eliges el destino y el viaje, y ves la tarifa: no se pide nada solo.";
}
