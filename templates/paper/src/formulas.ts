// The paper's display equations: one slot per numbered equation, a few
// LaTeX options per slot. The record's `eq1`…`eq4` field (a `choice` of the
// option index) picks which one prints; gt.json records the chosen LaTeX.
// Each option carries its own `\tag{n}`, so the equation number is part of
// the formula block, as in LaTeX.
export const formulas = {
  eq1: [
    String.raw`\hat{y} = \operatorname{softmax}(W \mathbf{h} + b) \tag{1}`,
    String.raw`\mathbf{h}_t = \tanh\left(W_x \mathbf{x}_t + W_h \mathbf{h}_{t-1} + \mathbf{b}\right) \tag{1}`,
    String.raw`\mathrm{Attention}(Q, K, V) = \mathrm{softmax}\left(\frac{Q K^{\top}}{\sqrt{d_k}}\right) V \tag{1}`,
  ],
  eq2: [
    String.raw`\mathcal{L}(\theta) = -\frac{1}{N} \sum_{i=1}^{N} \log p_{\theta}(y_i \mid x_i) \tag{2}`,
    String.raw`\mathcal{L} = \sum_{i=1}^{N} \lVert \mathbf{y}_i - \hat{\mathbf{y}}_i \rVert_2^2 + \lambda \lVert \theta \rVert_2^2 \tag{2}`,
    String.raw`\mathcal{L}_{\mathrm{IoU}} = 1 - \frac{\lvert B \cap B^{*} \rvert}{\lvert B \cup B^{*} \rvert} \tag{2}`,
  ],
  eq3: [
    String.raw`\theta_{t+1} = \theta_t - \eta \nabla_{\theta} \mathcal{L}(\theta_t) \tag{3}`,
    String.raw`m_t = \beta_1 m_{t-1} + (1 - \beta_1) g_t \tag{3}`,
    String.raw`\eta_t = \frac{\eta_0}{2} \left(1 + \cos \frac{t \pi}{T}\right) \tag{3}`,
  ],
  eq4: [
    String.raw`\mathrm{F}_1 = \frac{2 P R}{P + R} \tag{4}`,
    String.raw`\mathrm{CER} = \frac{S + D + I}{N} \times 100\% \tag{4}`,
    String.raw`\mathrm{mAP} = \frac{1}{\lvert C \rvert} \sum_{c \in C} \int_{0}^{1} p_c(r) \, dr \tag{4}`,
  ],
} as const satisfies Record<string, readonly string[]>;

export type FormulaSlot = keyof typeof formulas;
