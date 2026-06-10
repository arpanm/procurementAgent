package ai.procurecopilot.backend.common;

/**
 * Money helpers. All monetary amounts in the system are integer paise (₹1 = 100 paise) to avoid
 * floating-point drift in price comparisons and totals.
 */
public final class Money {

    private Money() {
    }

    /** Format paise as an Indian-grouped rupee string for narration, e.g. 2150050 → "₹21,500.50". */
    public static String formatRupees(long paise) {
        long abs = Math.abs(paise);
        long rupees = abs / 100;
        long fraction = abs % 100;
        String grouped = groupIndian(rupees);
        String sign = paise < 0 ? "-" : "";
        if (fraction == 0) {
            return sign + "₹" + grouped;
        }
        return String.format("%s₹%s.%02d", sign, grouped, fraction);
    }

    private static String groupIndian(long value) {
        String s = Long.toString(value);
        if (s.length() <= 3) {
            return s;
        }
        String last3 = s.substring(s.length() - 3);
        String rest = s.substring(0, s.length() - 3);
        StringBuilder sb = new StringBuilder();
        int count = 0;
        for (int i = rest.length() - 1; i >= 0; i--) {
            sb.append(rest.charAt(i));
            count++;
            if (count % 2 == 0 && i != 0) {
                sb.append(',');
            }
        }
        return sb.reverse() + "," + last3;
    }
}
