package ai.procurecopilot.backend.agent;

import ai.procurecopilot.backend.common.Domain;
import ai.procurecopilot.backend.llm.ClaudeRequest;
import ai.procurecopilot.backend.llm.ClaudeService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * Rule-based slot parser (PROCURE_COPILOT_PLAN.md Epic 1) that turns a vernacular
 * Hindi/Bengali/English order utterance into structured {@link Domain.RequestedItem}s.
 *
 * <p>It handles vernacular numerals (do/teen/paanch/das, Bengali/Devanagari digits), units
 * (kg/g/l/ml/piece/packet/carton/dozen and their vernacular spellings) and common item synonyms
 * (aloo→potato, pyaaz→onion, tel→oil, …). On top of that it extracts the <b>brand</b> ("India
 * Gate"/"Tata"), <b>variant</b> ("basmati"/"lite") and <b>pack size</b> ("1 kg") so the optimizer can
 * disambiguate the SKU on each platform.
 *
 * <p>Disambiguation of the numbers in a chunk like {@code "1kg india gate basmati rice 5 packets"}:
 * a number glued to a <i>measure</i> unit (kg/g/l/ml) becomes the {@code packSize} label ("1 kg"),
 * while a number glued to a <i>count</i> unit (packet/pcs/dozen/…) becomes {@code qty}+{@code unit}
 * (5 "packet"). A loose measure with no count ("2 kg potato") stays the qty/unit and leaves packSize
 * empty.
 *
 * <p>It produces a confidence score; when confidence is low — or when a real Anthropic key is
 * configured and the order looks branded/complex — it defers to a Claude "intent" call (a
 * deterministic stub in CI) and parses that JSON.
 *
 * <p>{@code canonicalItemId} is the normalized english name (lowercase, no spaces).
 */
@Service
public class IntentService {

    private static final Logger log = LoggerFactory.getLogger(IntentService.class);

    /** Below this overall confidence the parser defers to the Claude fallback. */
    static final double FALLBACK_THRESHOLD = 0.5;

    private final ClaudeService claude;
    private final ObjectMapper mapper;

    public IntentService(ClaudeService claude, ObjectMapper mapper) {
        this.claude = claude;
        this.mapper = mapper;
    }

    /** A parse outcome: the structured items plus a 0..1 confidence. */
    public record IntentResult(List<Domain.RequestedItem> items, double confidence) {
    }

    public IntentResult parse(String text, String locale) {
        IntentResult ruleResult = ruleParse(text);

        // Routing: the deterministic rule parser is always the offline/stub path. When a *real* key
        // is configured (stub mode off) AND the order looks branded/complex — i.e. the rule parser
        // already surfaced a brand/variant/pack-size, or a chunk carried both a pack-size and a
        // pack-count number — we prefer Claude's richer structured result, falling back to the rule
        // result if Claude returns nothing usable. In stub mode we never touch the network.
        if (claude != null && !claude.isStub() && looksBrandedOrComplex(text, ruleResult)) {
            IntentResult preferred = claudeFallback(text, locale);
            if (preferred != null && !preferred.items().isEmpty()) {
                return preferred;
            }
        }

        // Existing safety net: low rule confidence always tries the fallback (stub or live).
        if (ruleResult.confidence() >= FALLBACK_THRESHOLD) {
            return ruleResult;
        }
        IntentResult fallback = claudeFallback(text, locale);
        if (fallback != null && !fallback.items().isEmpty()) {
            return fallback;
        }
        return ruleResult;
    }

    /**
     * Heuristic for whether an order is worth a live Claude call: any detected brand, variant or
     * pack-size, or any single chunk that carries two or more numbers (a pack-size + a pack-count,
     * e.g. "1 kg … 5 packets"). Simple single-number items stay on the rule path.
     */
    private static boolean looksBrandedOrComplex(String text, IntentResult rule) {
        for (Domain.RequestedItem it : rule.items()) {
            if (it.brand() != null || it.variant() != null || it.packSize() != null) {
                return true;
            }
        }
        if (text == null || text.isBlank()) {
            return false;
        }
        String normalized = normalizeDigits(text).toLowerCase();
        for (String chunk : ITEM_SEPARATOR.split(normalized)) {
            int numbers = 0;
            Matcher m = INTEGER.matcher(chunk);
            while (m.find()) {
                numbers++;
            }
            if (numbers >= 2) {
                return true;
            }
        }
        return false;
    }

    // ---------------------------------------------------------------------------------------------
    // Rule parser
    // ---------------------------------------------------------------------------------------------

    IntentResult ruleParse(String text) {
        if (text == null || text.isBlank()) {
            return new IntentResult(List.of(), 0.0);
        }
        String normalized = normalizeDigits(text).toLowerCase();
        String[] chunks = ITEM_SEPARATOR.split(normalized);

        List<Domain.RequestedItem> items = new ArrayList<>();
        double confidenceSum = 0.0;
        int parsed = 0;
        for (String chunk : chunks) {
            ParsedChunk pc = parseChunk(chunk);
            if (pc == null) {
                continue;
            }
            items.add(pc.item());
            confidenceSum += pc.confidence();
            parsed++;
        }
        double confidence = parsed == 0 ? 0.0 : confidenceSum / parsed;
        return new IntentResult(items, round2(confidence));
    }

    private record ParsedChunk(Domain.RequestedItem item, double confidence) {
    }

    private ParsedChunk parseChunk(String chunk) {
        if (chunk == null || chunk.isBlank()) {
            return null;
        }
        // Split glued digit/letter pairs: "5kg" -> "5 kg", "kg5" -> "kg 5".
        String spaced = chunk
                .replaceAll("(\\d)([a-z])", "$1 $2")
                .replaceAll("([a-z])(\\d)", "$1 $2");
        String[] rawTokens = WHITESPACE.split(spaced.trim());

        // --- Pass 1: pull out numbers (paired with the following unit) and leave the descriptive
        // words (brand/variant/item tokens) in order for pass 2. ---
        Integer measureValue = null; // number tied to a measure unit (kg/g/l/ml) -> packSize
        String measureUnit = null;
        Integer countValue = null; // number tied to a count unit (packet/dozen/…) -> qty+unit
        String countUnit = null;
        Integer standaloneCount = null; // a bare number with no unit after it
        List<String> words = new ArrayList<>();

        for (int i = 0; i < rawTokens.length; i++) {
            String token = clean(rawTokens[i]);
            if (token.isEmpty()) {
                continue;
            }
            Integer number = asNumber(token);
            if (number != null) {
                String nextUnit = (i + 1 < rawTokens.length) ? UNITS.get(clean(rawTokens[i + 1])) : null;
                if (nextUnit != null && MEASURE_UNITS.contains(nextUnit)) {
                    if (measureValue == null) {
                        measureValue = number;
                        measureUnit = nextUnit;
                    }
                    i++; // consume the unit too
                } else if (nextUnit != null) {
                    if (countValue == null) {
                        countValue = number;
                        countUnit = nextUnit;
                    }
                    i++;
                } else if (standaloneCount == null) {
                    standaloneCount = number;
                }
                continue;
            }
            if (UNITS.containsKey(token)) { // a unit with no leading number ("packet doodh")
                String u = UNITS.get(token);
                if (MEASURE_UNITS.contains(u)) {
                    if (measureUnit == null) {
                        measureUnit = u;
                    }
                } else if (countUnit == null) {
                    countUnit = u;
                }
                continue;
            }
            if (FILLER.contains(token)) {
                continue;
            }
            words.add(token);
        }

        // --- Pass 2: classify the descriptive words into brand / variant / item name. ---
        boolean[] consumed = new boolean[words.size()];

        String brand = matchPhrase(words, consumed, BRANDS);
        String variant = matchAllPhrases(words, consumed, VARIANTS);

        // Phrase-aware item match (longest phrase wins) so multi-word items like "spring onion" are
        // recognized as their own canonical item rather than "onion" with a stray "spring" brand.
        String canonical = null;
        int itemStart = -1;
        int itemEnd = -1;
        ItemMatch match = matchItem(words, consumed);
        if (match != null) {
            canonical = match.canonical();
            itemStart = match.start();
            itemEnd = match.start() + match.len();
            markConsumed(consumed, match.start(), match.len());
        }
        boolean itemKnown = canonical != null;

        // No known synonym: the first meaningful leftover word becomes the (unknown) item name.
        if (canonical == null) {
            for (int i = 0; i < words.size(); i++) {
                if (!consumed[i] && words.get(i).length() > 1) {
                    canonical = words.get(i);
                    itemStart = i;
                    itemEnd = i + 1;
                    consumed[i] = true;
                    break;
                }
            }
        }
        if (canonical == null) {
            return null; // nothing item-like in this chunk
        }

        // Leftover words: those before the item are brand fallback; those after refine the variant.
        StringBuilder brandFallback = new StringBuilder();
        StringBuilder variantExtra = new StringBuilder();
        for (int i = 0; i < words.size(); i++) {
            if (consumed[i] || words.get(i).length() <= 1) {
                continue;
            }
            if (i < itemStart) {
                appendWord(brandFallback, words.get(i));
            } else {
                appendWord(variantExtra, words.get(i));
            }
        }
        if (brand == null && brandFallback.length() > 0) {
            brand = displayCase(brandFallback.toString());
        }
        if (variantExtra.length() > 0) {
            variant = variant == null ? variantExtra.toString() : variant + " " + variantExtra;
        }

        // --- Resolve qty / unit / packSize from the extracted numbers. ---
        int qty;
        String unit;
        String packSize = null;
        boolean qtyResolved;
        boolean unitResolved;
        boolean hasCount = countUnit != null || countValue != null || standaloneCount != null;
        if (hasCount) {
            Integer c = countValue != null ? countValue : standaloneCount;
            qty = c != null ? c : 1;
            qtyResolved = c != null;
            unit = countUnit != null ? countUnit : DEFAULT_UNIT;
            unitResolved = countUnit != null;
            if (measureValue != null && measureUnit != null) {
                packSize = measureValue + " " + measureUnit; // e.g. "1 kg"
            }
        } else if (measureValue != null && brand != null) {
            // A BRANDED packaged good given only a weight/volume ("Milky Mist paneer 500 g") — the
            // measure is the PACK SIZE, not a 500-unit order. Default the pack count to one. (Loose
            // produce like "2 kg potato" has no brand and stays a real qty below.)
            qty = 1;
            qtyResolved = false;
            unit = PACKAGED_UNIT;
            unitResolved = false;
            packSize = measureValue + " " + measureUnit;
        } else if (measureValue != null) {
            qty = measureValue;
            qtyResolved = true;
            unit = measureUnit;
            unitResolved = true;
        } else {
            qty = 1;
            qtyResolved = false;
            unit = DEFAULT_UNIT;
            unitResolved = false;
        }
        if (qty <= 0) {
            qty = 1;
        }

        double confidence = 1.0;
        if (!qtyResolved) {
            confidence -= 0.2;
        }
        if (!unitResolved) {
            confidence -= 0.2;
        }
        if (!itemKnown) {
            confidence -= 0.5;
        }
        confidence = Math.max(0.0, Math.min(1.0, confidence));

        String canonicalId = canonical.toLowerCase().replaceAll("\\s+", "");
        return new ParsedChunk(
                new Domain.RequestedItem(canonicalId, canonical, qty, unit, brand, variant, packSize),
                confidence);
    }

    // ---------------------------------------------------------------------------------------------
    // Claude fallback
    // ---------------------------------------------------------------------------------------------

    private IntentResult claudeFallback(String text, String locale) {
        try {
            String system = "You extract grocery order line items. Respond with ONLY JSON: "
                    + "{\"items\":[{\"canonicalItemId\":string,\"name\":string,\"qty\":int,"
                    + "\"unit\":string,\"brand\":string|null,\"variant\":string|null,"
                    + "\"packSize\":string|null}],\"confidence\":number}. "
                    + "canonicalItemId is the normalized english name, lowercase, no spaces. "
                    + "qty/unit are the pack COUNT (e.g. 5 \"packet\"). brand is the manufacturer "
                    + "(e.g. \"India Gate\", \"Tata\"), variant is the grade/descriptor (e.g. "
                    + "\"basmati\", \"lite\"), packSize is the per-pack measure as a label like "
                    + "\"1 kg\" or \"500 g\". Use null for brand/variant/packSize when absent. "
                    + "CRITICAL: a bare weight/volume with NO count word (e.g. \"500 g\", \"1 kg\", "
                    + "\"250 ml\") is the packSize, NOT the qty — set packSize to it and qty to 1. "
                    + "NEVER put a gram/kg/ml/litre number in qty; qty is ONLY an explicit pack count "
                    + "such as \"5 packets\" or \"2 dozen\". Loose produce sold by weight (e.g. "
                    + "\"2 kg potato\", with no brand) keeps qty=2, unit=\"kg\".";
            String user = "locale=" + (locale == null ? "unknown" : locale) + "\norder=" + text;
            String raw = claude.complete(new ClaudeRequest("intent", system, user, 512));
            return parseIntentJson(raw);
        } catch (RuntimeException e) {
            log.debug("Intent fallback failed, keeping rule result", e);
            return null;
        }
    }

    private IntentResult parseIntentJson(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            JsonNode root = mapper.readTree(raw);
            JsonNode itemsNode = root.path("items");
            if (!itemsNode.isArray()) {
                return null;
            }
            List<Domain.RequestedItem> items = new ArrayList<>();
            for (JsonNode n : itemsNode) {
                String name = n.path("name").asText("").trim();
                String canonicalId = n.path("canonicalItemId").asText("").trim();
                if (canonicalId.isEmpty() && !name.isEmpty()) {
                    canonicalId = name.toLowerCase().replaceAll("\\s+", "");
                }
                if (canonicalId.isEmpty()) {
                    continue;
                }
                int qty = Math.max(1, n.path("qty").asInt(1));
                String unit = n.path("unit").asText(DEFAULT_UNIT).trim();
                if (unit.isEmpty()) {
                    unit = DEFAULT_UNIT;
                }
                String brand = optionalText(n, "brand");
                String variant = optionalText(n, "variant");
                String packSize = optionalText(n, "packSize");
                items.add(new Domain.RequestedItem(canonicalId, name.isEmpty() ? canonicalId : name,
                        qty, unit, brand, variant, packSize));
            }
            double confidence = round2(root.path("confidence").asDouble(0.5));
            return new IntentResult(items, confidence);
        } catch (Exception e) {
            log.debug("Could not parse intent fallback JSON", e);
            return null;
        }
    }

    /** Read an optional nullable string field, returning null for missing/null/blank/"null". */
    private static String optionalText(JsonNode node, String field) {
        JsonNode n = node.path(field);
        if (n.isMissingNode() || n.isNull()) {
            return null;
        }
        String v = n.asText("").trim();
        if (v.isEmpty() || v.equalsIgnoreCase("null")) {
            return null;
        }
        return v;
    }

    // ---------------------------------------------------------------------------------------------
    // Normalization helpers
    // ---------------------------------------------------------------------------------------------

    /** Map Bengali (০-৯) and Devanagari (०-९) digits to ASCII so numeral handling is uniform. */
    static String normalizeDigits(String input) {
        StringBuilder sb = new StringBuilder(input.length());
        for (int i = 0; i < input.length(); i++) {
            char c = input.charAt(i);
            if (c >= '\u09E6' && c <= '\u09EF') { // Bengali digits
                sb.append((char) ('0' + (c - '\u09E6')));
            } else if (c >= '\u0966' && c <= '\u096F') { // Devanagari digits
                sb.append((char) ('0' + (c - '\u0966')));
            } else {
                sb.append(c);
            }
        }
        return sb.toString();
    }

    /** Strip a token down to [a-z0-9]; tokens are already lowercased upstream. */
    private static String clean(String rawToken) {
        return rawToken.replaceAll("[^a-z0-9]", "");
    }

    /** Parse a cleaned token as an ASCII integer or a vernacular number word, else null. */
    private static Integer asNumber(String token) {
        if (INTEGER.matcher(token).matches()) {
            return safeInt(token);
        }
        return NUMBER_WORDS.get(token);
    }

    /** A resolved item phrase: its canonical english name and the [start, start+len) span it covers. */
    private record ItemMatch(String canonical, int start, int len) {
    }

    /**
     * Find the item synonym in {@code words}, scanning left-to-right and trying the longest phrase
     * (up to 3 words) at each position first — so "spring onion" wins over the single token "onion",
     * and "black pepper" over "pepper". Does not mark consumption (the caller does); returns null when
     * no synonym phrase is present.
     */
    private static ItemMatch matchItem(List<String> words, boolean[] consumed) {
        for (int i = 0; i < words.size(); i++) {
            if (consumed[i]) {
                continue;
            }
            for (int len = Math.min(3, words.size() - i); len >= 1; len--) {
                if (anyConsumed(consumed, i, len)) {
                    continue;
                }
                String canon = SYNONYMS.get(join(words, i, len));
                if (canon != null) {
                    return new ItemMatch(canon, i, len);
                }
            }
        }
        return null;
    }

    /**
     * Find the first (longest) phrase from {@code dict} starting at any unconsumed position, marking
     * its tokens consumed and returning the display form. Supports up to 3-word phrases.
     */
    private static String matchPhrase(List<String> words, boolean[] consumed, Map<String, String> dict) {
        for (int i = 0; i < words.size(); i++) {
            if (consumed[i]) {
                continue;
            }
            for (int len = Math.min(3, words.size() - i); len >= 1; len--) {
                if (anyConsumed(consumed, i, len)) {
                    continue;
                }
                String phrase = join(words, i, len);
                if (dict.containsKey(phrase)) {
                    markConsumed(consumed, i, len);
                    return dict.get(phrase);
                }
            }
        }
        return null;
    }

    /** Like {@link #matchPhrase} but collects every match (space-joined) — used for variants. */
    private static String matchAllPhrases(List<String> words, boolean[] consumed, Map<String, String> dict) {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < words.size(); i++) {
            if (consumed[i]) {
                continue;
            }
            for (int len = Math.min(3, words.size() - i); len >= 1; len--) {
                if (anyConsumed(consumed, i, len)) {
                    continue;
                }
                String phrase = join(words, i, len);
                if (dict.containsKey(phrase)) {
                    markConsumed(consumed, i, len);
                    appendWord(out, dict.get(phrase));
                    break;
                }
            }
        }
        return out.length() == 0 ? null : out.toString();
    }

    private static boolean anyConsumed(boolean[] consumed, int from, int len) {
        for (int k = 0; k < len; k++) {
            if (consumed[from + k]) {
                return true;
            }
        }
        return false;
    }

    private static void markConsumed(boolean[] consumed, int from, int len) {
        for (int k = 0; k < len; k++) {
            consumed[from + k] = true;
        }
    }

    private static String join(List<String> words, int from, int len) {
        StringBuilder sb = new StringBuilder();
        for (int k = 0; k < len; k++) {
            if (k > 0) {
                sb.append(' ');
            }
            sb.append(words.get(from + k));
        }
        return sb.toString();
    }

    private static void appendWord(StringBuilder sb, String word) {
        if (word == null || word.isEmpty()) {
            return;
        }
        if (sb.length() > 0) {
            sb.append(' ');
        }
        sb.append(word);
    }

    /** Title-case each word ("india gate" -> "India Gate") for display of unknown brands. */
    private static String displayCase(String s) {
        String[] parts = WHITESPACE.split(s.trim());
        StringBuilder sb = new StringBuilder();
        for (String p : parts) {
            if (p.isEmpty()) {
                continue;
            }
            if (sb.length() > 0) {
                sb.append(' ');
            }
            sb.append(Character.toUpperCase(p.charAt(0))).append(p.substring(1));
        }
        return sb.toString();
    }

    private static Integer safeInt(String s) {
        try {
            long v = Long.parseLong(s);
            if (v > Integer.MAX_VALUE) {
                return Integer.MAX_VALUE;
            }
            return (int) v;
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static double round2(double v) {
        return Math.round(v * 100.0) / 100.0;
    }

    // ---------------------------------------------------------------------------------------------
    // Dictionaries
    // ---------------------------------------------------------------------------------------------

    private static final String DEFAULT_UNIT = "piece";
    /** Unit assumed for a branded packaged good whose order gives only a pack size (no count). */
    private static final String PACKAGED_UNIT = "packet";

    private static final Pattern WHITESPACE = Pattern.compile("\\s+");
    private static final Pattern INTEGER = Pattern.compile("\\d+");

    /** Item separators: aur / and / ebong / tatha / o (Bengali "and") / commas / + / &. */
    private static final Pattern ITEM_SEPARATOR = Pattern.compile(
            "\\s*(?:,|\\+|&|\\band\\b|\\baur\\b|\\bor\\b|\\bebong\\b|\\btatha\\b|\\bo\\b)\\s*");

    /** Canonical measure units (a number tied to one of these becomes the {@code packSize}). */
    private static final Set<String> MEASURE_UNITS = Set.of("kg", "g", "l", "ml");

    private static final Map<String, Integer> NUMBER_WORDS = Map.ofEntries(
            Map.entry("ek", 1), Map.entry("ik", 1), Map.entry("eka", 1), Map.entry("ekta", 1),
            Map.entry("do", 2), Map.entry("dui", 2), Map.entry("duto", 2),
            Map.entry("teen", 3), Map.entry("tin", 3), Map.entry("tinte", 3),
            Map.entry("char", 4), Map.entry("chaar", 4), Map.entry("charte", 4),
            Map.entry("paanch", 5), Map.entry("panch", 5), Map.entry("paach", 5), Map.entry("pach", 5),
            Map.entry("chhe", 6), Map.entry("che", 6), Map.entry("chay", 6), Map.entry("choy", 6),
            Map.entry("saat", 7), Map.entry("sat", 7),
            Map.entry("aath", 8), Map.entry("aat", 8),
            Map.entry("nau", 9), Map.entry("noy", 9), Map.entry("nou", 9),
            Map.entry("das", 10), Map.entry("dosh", 10), Map.entry("dos", 10),
            Map.entry("gyarah", 11), Map.entry("egaro", 11),
            Map.entry("barah", 12), Map.entry("baro", 12), Map.entry("baroh", 12));

    private static final Map<String, String> UNITS = Map.ofEntries(
            Map.entry("kg", "kg"), Map.entry("kgs", "kg"), Map.entry("kilo", "kg"),
            Map.entry("kilos", "kg"), Map.entry("kilogram", "kg"), Map.entry("kilograms", "kg"),
            Map.entry("g", "g"), Map.entry("gm", "g"), Map.entry("gms", "g"), Map.entry("gram", "g"),
            Map.entry("grams", "g"),
            Map.entry("l", "l"), Map.entry("ltr", "l"), Map.entry("litre", "l"),
            Map.entry("litres", "l"), Map.entry("liter", "l"), Map.entry("liters", "l"),
            Map.entry("ml", "ml"),
            Map.entry("piece", "piece"), Map.entry("pieces", "piece"), Map.entry("pcs", "piece"),
            Map.entry("pc", "piece"), Map.entry("nos", "piece"), Map.entry("nag", "piece"),
            Map.entry("ta", "piece"),
            Map.entry("packet", "packet"), Map.entry("packets", "packet"), Map.entry("pkt", "packet"),
            Map.entry("pkts", "packet"), Map.entry("pack", "packet"), Map.entry("packs", "packet"),
            Map.entry("carton", "carton"), Map.entry("cartons", "carton"), Map.entry("cartoon", "carton"),
            Map.entry("cartoons", "carton"), Map.entry("ctn", "carton"), Map.entry("box", "carton"),
            Map.entry("boxes", "carton"),
            Map.entry("dozen", "dozen"), Map.entry("dozens", "dozen"), Map.entry("darjan", "dozen"),
            Map.entry("darzan", "dozen"), Map.entry("dozon", "dozen"));

    /** Curated grocery brands (normalized lowercase phrase -> display form). Longest match wins. */
    private static final Map<String, String> BRANDS = buildBrands();

    private static Map<String, String> buildBrands() {
        LinkedHashMap<String, String> m = new LinkedHashMap<>();
        brand(m, "India Gate");
        brand(m, "Daawat");
        brand(m, "Fortune");
        brand(m, "Tata Sampann");
        brand(m, "Tata");
        brand(m, "Aashirvaad");
        brand(m, "Amul");
        brand(m, "Mother Dairy");
        brand(m, "Saffola");
        brand(m, "Patanjali");
        brand(m, "Nestle");
        brand(m, "MDH");
        brand(m, "Everest");
        brand(m, "Catch");
        brand(m, "Maggi");
        brand(m, "Kohinoor");
        brand(m, "Sundrop");
        brand(m, "Dhara");
        brand(m, "Parle");
        brand(m, "Britannia");
        return Map.copyOf(m);
    }

    private static void brand(Map<String, String> m, String display) {
        m.put(display.toLowerCase(), display);
    }

    /** Descriptive grade/variant tokens (normalized phrase -> display). Longest match wins. */
    private static final Map<String, String> VARIANTS = buildVariants();

    private static Map<String, String> buildVariants() {
        LinkedHashMap<String, String> m = new LinkedHashMap<>();
        for (String v : new String[] {
                "basmati", "sona masoori", "lite", "light", "refined", "full cream",
                "double toned", "toned", "double", "premium", "organic", "raw", "brown",
                "white", "iodized", "rock"}) {
            m.put(v, v);
        }
        return Map.copyOf(m);
    }

    private static final Map<String, String> SYNONYMS = buildSynonyms();

    private static Map<String, String> buildSynonyms() {
        java.util.HashMap<String, String> m = new java.util.HashMap<>();
        // Multi-word items are registered FIRST and matched by longest-phrase, so distinct items like
        // "spring onion" are not collapsed onto the single-token "onion" (with a stray "spring" brand).
        put(m, "spring onion", "spring onion", "spring onions", "hara pyaaz", "hara pyaz",
                "pyaz patta");
        put(m, "green chilli", "green chilli", "green chillies", "green chili", "hari mirch",
                "hari mirchi");
        put(m, "red chilli", "red chilli", "red chillies", "lal mirch", "laal mirch");
        put(m, "black pepper", "black pepper", "kali mirch", "kalimirch");
        put(m, "capsicum", "capsicum", "bell pepper", "bell peppers", "shimla mirch");
        put(m, "bay leaf", "bay leaf", "bay leaves", "tej patta", "tejpatta");
        put(m, "curry leaves", "curry leaves", "curry leaf", "kadi patta", "kari patta");
        put(m, "sweet corn", "sweet corn", "sweetcorn");
        put(m, "baby corn", "baby corn");
        put(m, "french beans", "french beans", "french bean", "green beans");
        put(m, "green peas", "green peas", "hari matar");
        put(m, "bottle gourd", "bottle gourd", "lauki", "ghiya");
        put(m, "bitter gourd", "bitter gourd", "karela");
        put(m, "potato", "aloo", "alu", "aaloo", "potato", "potatoes");
        put(m, "onion", "pyaaz", "pyaz", "peyaj", "piyaj", "pyaj", "onion", "onions");
        put(m, "oil", "tel", "oil");
        put(m, "paneer", "paneer", "panir");
        put(m, "flour", "atta", "ata", "aata", "flour");
        put(m, "rice", "chawal", "chaval", "chal", "rice");
        put(m, "milk", "doodh", "dudh", "dood", "milk");
        put(m, "sugar", "cheeni", "chini", "chinii", "cheenee", "sugar");
        put(m, "tomato", "tamatar", "tomato", "tomatoes");
        put(m, "ginger", "adrak", "ginger");
        put(m, "garlic", "lehsun", "lasun", "lehsoon", "garlic");
        put(m, "salt", "namak", "noon", "salt");
        put(m, "butter", "makhan", "butter");
        put(m, "ghee", "ghee", "ghi");
        put(m, "lentil", "dal", "daal", "lentil", "lentils", "dahl");
        put(m, "egg", "anda", "ande", "dim", "egg", "eggs");
        put(m, "chicken", "chicken", "murgi", "murga");
        put(m, "maida", "maida");
        put(m, "besan", "besan");
        put(m, "cumin", "jeera", "cumin");
        put(m, "turmeric", "haldi", "turmeric");
        put(m, "chilli", "mirchi", "mirch", "chilli", "chili", "chillies");
        put(m, "coriander", "dhania", "coriander");
        put(m, "tea", "chai", "tea", "cha");
        put(m, "coffee", "coffee", "kofi");
        put(m, "lemon", "nimbu", "lemon", "lime");
        put(m, "carrot", "gajar", "carrot");
        put(m, "peas", "matar", "peas", "mutter");
        put(m, "cauliflower", "gobi", "gobhi", "cauliflower");
        put(m, "okra", "bhindi", "okra");
        put(m, "brinjal", "baingan", "brinjal", "eggplant");
        return Map.copyOf(m);
    }

    private static void put(Map<String, String> m, String canonical, String... synonyms) {
        for (String s : synonyms) {
            m.put(s, canonical);
        }
    }

    /** Filler/command words that are neither qty, unit, nor item. */
    private static final Set<String> FILLER = Set.of(
            "ka", "ki", "ke", "ko", "se", "mein", "me", "chahiye", "lao", "dena", "do",
            "please", "order", "kar", "karo", "de", "den", "the", "a", "an", "some", "of",
            "send", "want", "need", "get", "buy", "la", "dao", "lagbe");

    /** Test/diagnostic visibility into the dictionaries. */
    static List<String> knownSynonyms() {
        return new ArrayList<>(SYNONYMS.keySet());
    }

    static List<String> knownUnits() {
        return new ArrayList<>(Arrays.asList(UNITS.keySet().toArray(new String[0])));
    }
}
