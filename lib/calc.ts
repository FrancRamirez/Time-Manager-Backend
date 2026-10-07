// ---------------------------------------------------------------------------
// Calculadora exacta para el asistente (herramienta "calculate")
// ---------------------------------------------------------------------------
//
// Los modelos de lenguaje se equivocan en cuentas de varios pasos (presupuestos, áreas, pesos, cantidades de
// material). Esta calculadora las resuelve de forma exacta y determinista. NO usa eval ni Function: es un
// analizador propio que solo entiende números, operadores, paréntesis, unas pocas funciones y variables que el
// propio pedido definió con "label". Todo lo demás se rechaza con un mensaje claro.
//
// Gramática (la potencia es asociativa a la derecha; el menos unario pesa menos que la potencia: -2^2 = -4):
//   expr    := term (('+' | '-') term)*
//   term    := unary (('*' | '/') unary)*
//   unary   := ('-' | '+') unary | power
//   power   := primary ('^' unary)?
//   primary := número | variable | constante | función '(' args ')' | '(' expr ')'

const MAX_EXPRESSIONS = 25;
const MAX_EXPRESSION_CHARS = 200;
const MAX_TOKENS = 120;
const MAX_DEPTH = 30;

type Token =
  | { t: "num"; v: number }
  | { t: "id"; v: string }
  | { t: "op"; v: "+" | "-" | "*" | "/" | "^" | "(" | ")" | "," };

/** Funciones admitidas: cantidad mínima y máxima de argumentos. Las trigonométricas usan GRADOS. */
const FUNCTIONS: Record<string, { min: number; max: number; run: (a: number[]) => number }> = {
  sqrt: { min: 1, max: 1, run: ([x]) => Math.sqrt(x) },
  abs: { min: 1, max: 1, run: ([x]) => Math.abs(x) },
  ceil: { min: 1, max: 1, run: ([x]) => Math.ceil(x) },
  floor: { min: 1, max: 1, run: ([x]) => Math.floor(x) },
  round: {
    min: 1,
    max: 2,
    run: ([x, d]) => {
      const k = 10 ** Math.min(10, Math.max(0, Math.trunc(d ?? 0)));
      return Math.round((x + Number.EPSILON * Math.sign(x)) * k) / k;
    },
  },
  min: { min: 1, max: 10, run: (a) => Math.min(...a) },
  max: { min: 1, max: 10, run: (a) => Math.max(...a) },
  pow: { min: 2, max: 2, run: ([x, y]) => Math.pow(x, y) },
  ln: { min: 1, max: 1, run: ([x]) => Math.log(x) },
  log10: { min: 1, max: 1, run: ([x]) => Math.log10(x) },
  sin: { min: 1, max: 1, run: ([x]) => Math.sin((x * Math.PI) / 180) },
  cos: { min: 1, max: 1, run: ([x]) => Math.cos((x * Math.PI) / 180) },
  tan: { min: 1, max: 1, run: ([x]) => Math.tan((x * Math.PI) / 180) },
};

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

/** Nombres que no se pueden usar como label (chocarían con una función o constante). */
const RESERVED = new Set([...Object.keys(FUNCTIONS), ...Object.keys(CONSTANTS)]);

class CalcError extends Error {}

/** Búsqueda solo entre las propiedades propias: "constructor" o "__proto__" no son funciones ni constantes. */
const own = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t") {
      i++;
    } else if (/[0-9.]/.test(c)) {
      const m = /^(?:\d+(?:\.\d+)?|\.\d+)/.exec(src.slice(i));
      if (!m) throw new CalcError("Número mal escrito: usa punto decimal (por ejemplo 1.5), sin separador de miles.");
      out.push({ t: "num", v: Number(m[0]) });
      i += m[0].length;
      // "2m", "3x", "1,5": un número pegado a letras o a otro número no es válido.
      if (/[A-Za-z_]/.test(src[i] ?? "")) throw new CalcError("Falta un operador (por ejemplo * ) entre el número y el nombre.");
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ t: "id", v: m[0].toLowerCase() });
      i += m[0].length;
    } else if ("+-*/^(),".includes(c)) {
      out.push({ t: "op", v: c as Extract<Token, { t: "op" }>["v"] });
      i++;
    } else {
      throw new CalcError(
        c === "%"
          ? "No uses %: para un porcentaje multiplica (15% de x = x * 0.15)."
          : `Carácter no permitido: "${c}". Solo números, + - * / ^, paréntesis y funciones.`
      );
    }
    if (out.length > MAX_TOKENS) throw new CalcError("La expresión es demasiado larga: divídela en pasos.");
  }
  return out;
}

class Parser {
  private pos = 0;
  private depth = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly vars: Map<string, number>
  ) {}

  parse(): number {
    const v = this.expr();
    if (this.pos < this.tokens.length) throw new CalcError("Sobra algo al final de la expresión.");
    return v;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private isOp(v: string): boolean {
    const t = this.peek();
    return t?.t === "op" && t.v === v;
  }
  private enter() {
    if (++this.depth > MAX_DEPTH) throw new CalcError("La expresión tiene demasiados paréntesis anidados.");
  }
  private leave() {
    this.depth--;
  }

  private expr(): number {
    let v = this.term();
    while (this.isOp("+") || this.isOp("-")) {
      const op = (this.tokens[this.pos++] as { v: string }).v;
      const r = this.term();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }

  private term(): number {
    let v = this.unary();
    while (this.isOp("*") || this.isOp("/")) {
      const op = (this.tokens[this.pos++] as { v: string }).v;
      const r = this.unary();
      if (op === "/") {
        if (r === 0) throw new CalcError("División por cero.");
        v /= r;
      } else {
        v *= r;
      }
    }
    return v;
  }

  private unary(): number {
    this.enter();
    try {
      if (this.isOp("-")) {
        this.pos++;
        return -this.unary();
      }
      if (this.isOp("+")) {
        this.pos++;
        return this.unary();
      }
      return this.power();
    } finally {
      this.leave();
    }
  }

  private power(): number {
    const base = this.primary();
    if (this.isOp("^")) {
      this.pos++;
      const exp = this.unary();
      const r = Math.pow(base, exp);
      if (!Number.isFinite(r)) throw new CalcError("El resultado de la potencia es demasiado grande o no es un número real.");
      return r;
    }
    return base;
  }

  private primary(): number {
    const t = this.tokens[this.pos++];
    if (!t) throw new CalcError("La expresión está incompleta.");
    if (t.t === "num") return t.v;

    if (t.t === "op") {
      if (t.v !== "(") throw new CalcError(`No se esperaba "${t.v}" acá.`);
      this.enter();
      const v = this.expr();
      this.leave();
      if (!this.isOp(")")) throw new CalcError("Falta cerrar un paréntesis.");
      this.pos++;
      return v;
    }

    // Identificador: función, constante o variable definida antes.
    if (this.isOp("(")) {
      const fn = own(FUNCTIONS, t.v) ? FUNCTIONS[t.v] : undefined;
      if (!fn) throw new CalcError(`Función desconocida: ${t.v}.`);
      this.pos++;
      const args: number[] = [];
      this.enter();
      if (!this.isOp(")")) {
        args.push(this.expr());
        while (this.isOp(",")) {
          this.pos++;
          args.push(this.expr());
        }
      }
      this.leave();
      if (!this.isOp(")")) throw new CalcError("Falta cerrar un paréntesis.");
      this.pos++;
      if (args.length < fn.min || args.length > fn.max) throw new CalcError(`${t.v} recibe una cantidad de argumentos incorrecta.`);
      const r = fn.run(args);
      if (!Number.isFinite(r)) throw new CalcError(`${t.v} no tiene resultado para ese valor.`);
      return r;
    }
    if (own(CONSTANTS, t.v)) return CONSTANTS[t.v];
    const known = this.vars.get(t.v);
    if (known !== undefined) return known;
    throw new CalcError(`No conozco "${t.v}". Define antes ese valor con un label o escríbelo como número.`);
  }
}

export type CalcResult = { ok: true; value: number } | { ok: false; error: string };

/** Evalúa una expresión. `vars` son los resultados anteriores del mismo pedido (por label). */
export function evaluate(expression: string, vars: Map<string, number> = new Map()): CalcResult {
  try {
    if (typeof expression !== "string" || !expression.trim()) throw new CalcError("Falta la expresión.");
    if (expression.length > MAX_EXPRESSION_CHARS) throw new CalcError("La expresión es demasiado larga: divídela en pasos.");
    const value = new Parser(tokenize(expression), vars).parse();
    if (!Number.isFinite(value)) throw new CalcError("El resultado no es un número válido.");
    // 12 cifras significativas: se limpia el ruido de la coma flotante (0.1 + 0.2 -> 0.3).
    return { ok: true, value: Number(value.toPrecision(12)) };
  } catch (err) {
    if (err instanceof CalcError) return { ok: false, error: err.message };
    return { ok: false, error: "No pude calcular esa expresión." };
  }
}

const LABEL = /^[a-z_][a-z0-9_]{0,39}$/;

/**
 * Resuelve el pedido completo de la herramienta: una lista de expresiones, cada una con un label opcional que
 * las siguientes pueden usar como variable. Un error en una expresión no frena las demás.
 */
export function runCalculations(raw: unknown): Record<string, unknown> {
  if (!Array.isArray(raw) || raw.length === 0) return { error: "Falta expressions: una lista con al menos una expresión." };
  if (raw.length > MAX_EXPRESSIONS) return { error: `Son demasiadas operaciones: el máximo es ${MAX_EXPRESSIONS} por llamada.` };

  const vars = new Map<string, number>();
  const results = raw.map((item) => {
    const o = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
    const expression = typeof o.expression === "string" ? o.expression : "";
    const labelRaw = typeof o.label === "string" ? o.label.trim().toLowerCase() : "";

    let labelError: string | undefined;
    if (labelRaw && (!LABEL.test(labelRaw) || RESERVED.has(labelRaw) || vars.has(labelRaw))) {
      labelError = `El label "${labelRaw}" no es válido o ya se usó (usa letras minúsculas, números y _; no puede ser una función ni pi/e).`;
    }

    const res = evaluate(expression, vars);
    const base = { ...(labelRaw ? { label: labelRaw } : {}), expression: expression.slice(0, MAX_EXPRESSION_CHARS) };
    if (!res.ok) return { ...base, error: res.error };
    if (labelRaw && !labelError) vars.set(labelRaw, res.value);
    return { ...base, value: res.value, text: String(res.value), ...(labelError ? { warning: labelError } : {}) };
  });

  return {
    results,
    note: "Cálculo exacto: usa estos valores tal cual en tu respuesta (redondea solo al presentarlos). Si alguno trae error, corrige esa expresión y vuelve a llamar.",
  };
}
