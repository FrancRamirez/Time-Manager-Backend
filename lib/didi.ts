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
import { tr } from "./lang";

export interface DidiBody {
  kind: "didi_open";
  /** Dónde quiere ir; la app lo copia al portapapeles. Opcional: puede abrir DiDi sin destino. */
  destination?: string;
}

/** Destino válido o null (texto de 2 a 200 caracteres, sin saltos de línea ni caracteres de control). */
export const cleanDidiDestination = cleanPlaceText;

export function describeDidi(b: DidiBody): string {
  return b.destination
    ? tr(
        `Abrir DiDi y copiar el destino "${b.destination}" para que lo pegues en "¿A dónde vas?". ` +
          "Tú eliges el viaje, ves la tarifa y lo pides: no se pide solo.",
        `Open DiDi and copy the destination "${b.destination}" so you can paste it into "Where to?". ` +
          "You choose the ride, see the fare and request it: nothing is requested automatically."
      )
    : tr(
        "Abrir DiDi. Tú eliges el destino y el viaje, y ves la tarifa: no se pide nada solo.",
        "Open DiDi. You choose the destination and the ride, and you see the fare: nothing is requested automatically."
      );
}
