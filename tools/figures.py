import json
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager
from sklearn.metrics import roc_auc_score, roc_curve

for f in ("hg-Regular.ttf", "hg-SemiBold.ttf"):
    font_manager.fontManager.addfont(f)
OUT = "/Users/hridyaagrawal/honey/reef-response/design/figures"
THEMES = {
    "light": dict(bg="#ffffff", ink="#0f0f0d", ink2="#52514e", grid="#e6e4df", ours="#1666a8", noaa="#c2410c", ref="#b5b3ad"),
    "dark": dict(bg="#0d1b24", ink="#f0efec", ink2="#a9b4bb", grid="#22343f", ours="#4590d8", noaa="#e2672b", ref="#5b6b75"),
}

feat = pd.read_parquet("feat.parquet")
feat["y30"] = (feat.pct >= 30).astype(int)
pt = pd.read_parquet("pt.parquet")
te = {}
for target in ("y_mod", "y30", "y_sev"):
    q = pt[pt.target == target].set_index("row").p
    d = feat.loc[q.index].assign(p=q.values)
    te[target] = d[d.noaa_dhw_same_day.notna() & d.noaa_dhw_max90.notna()]
LABELS = {"y_mod": "10% or more of coral", "y30": "30% or more", "y_sev": "50% or more"}

rng = np.random.default_rng(0)
def boot_ci(d, col, target, n=1000):
    sites = d.Site_ID.unique()
    groups = {s: idx for s, idx in d.groupby("Site_ID").indices.items()}
    vals = []
    for _ in range(n):
        idx = np.concatenate([groups[s] for s in rng.choice(sites, len(sites))])
        y = d[target].values[idx]
        if y.min() == y.max():
            continue
        vals.append(roc_auc_score(y, d[col].values[idx]))
    return np.percentile(vals, [2.5, 97.5])

stats = {}
for target, d in te.items():
    stats[target] = {col: (roc_auc_score(d[target], d[col]), boot_ci(d, col, target)) for col in ("p", "noaa_dhw_same_day", "noaa_dhw_max90")}
    print(target, len(d), int(d[target].sum()), {k: round(v[0], 3) for k, v in stats[target].items()})

sv = pd.read_parquet("sv.parquet")
rows = np.array([r for s in sv.s for r in json.loads(s)], dtype=float)
yr, mo, pct, dhw, res = rows.T
yb = pct >= 10
pb = (yb.astype(float) - res) >= 0.5
nb = dhw >= 4
acc = {"All years": ((pb == yb).mean(), (nb == yb).mean(), len(yb)), "2016 to 2020": ((pb == yb)[yr >= 2016].mean(), (nb == yb)[yr >= 2016].mean(), int((yr >= 2016).sum()))}
print(acc)

def style(ax, t):
    ax.set_facecolor(t["bg"])
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    for s in ("left", "bottom"):
        ax.spines[s].set_color(t["grid"])
    ax.tick_params(colors=t["ink2"], labelsize=11, length=0, pad=6)
    ax.grid(color=t["grid"], linewidth=0.8)
    ax.set_axisbelow(True)

def head(fig, t, title, sub):
    fig.text(0.06, 0.95, title, fontsize=19, fontweight="semibold", color=t["ink"], va="top")
    fig.text(0.06, 0.885, sub, fontsize=12, color=t["ink2"], va="top")

def foot(fig, t, text):
    fig.text(0.06, 0.025, text, fontsize=9.5, color=t["ink2"], va="bottom")

for name, t in THEMES.items():
    plt.rcParams.update({"font.family": "Hanken Grotesk", "text.color": t["ink"]})

    d = te["y_mod"]
    fig = plt.figure(figsize=(9, 8), dpi=200, facecolor=t["bg"])
    ax = fig.add_axes([0.11, 0.16, 0.84, 0.66])
    style(ax, t)
    ax.plot([0, 1], [0, 1], color=t["ref"], lw=1.2, ls=(0, (2, 3)))
    ax.text(0.62, 0.55, "Coin flip", color=t["ref"], fontsize=11, rotation=40, rotation_mode="anchor")
    curves = [("noaa_dhw_max90", t["noaa"], (0, (5, 3)), "NOAA heat alert, 90-day peak"), ("noaa_dhw_same_day", t["noaa"], "-", "NOAA heat alert, survey day"), ("p", t["ours"], "-", "Coralytics")]
    for col, c, ls, lab in curves:
        fpr, tpr, _ = roc_curve(d.y_mod, d[col])
        auc = stats["y_mod"][col][0]
        ax.plot(fpr, tpr, color=c, lw=2.6 if col == "p" else 2, ls=ls, label=f"{lab}  {auc:.2f}", solid_capstyle="round")
    fp = ((d.noaa_dhw_same_day >= 4) & (d.y_mod == 0)).sum() / (d.y_mod == 0).sum()
    tp = ((d.noaa_dhw_same_day >= 4) & (d.y_mod == 1)).sum() / (d.y_mod == 1).sum()
    ax.scatter([fp], [tp], s=70, color=t["noaa"], edgecolor=t["bg"], linewidth=2, zorder=5)
    ax.annotate("NOAA's alert level\n(4 degree heating weeks)", (fp, tp), xytext=(fp + 0.08, tp - 0.17), fontsize=10.5, color=t["ink2"], arrowprops=dict(arrowstyle="-", color=t["ink2"], lw=0.8))
    tpr_same = ((d.p >= np.quantile(d.p[d.y_mod == 0], 1 - fp)) & (d.y_mod == 1)).sum() / (d.y_mod == 1).sum()
    ax.scatter([fp], [tpr_same], s=70, color=t["ours"], edgecolor=t["bg"], linewidth=2, zorder=5)
    ax.annotate(f"Same false alarms:\ncatches {tpr_same:.0%} vs {tp:.0%}", (fp, tpr_same), xytext=(fp + 0.08, tpr_same + 0.02), fontsize=10.5, color=t["ink"], arrowprops=dict(arrowstyle="-", color=t["ink2"], lw=0.8))
    ax.set_xlim(0, 1); ax.set_ylim(0, 1.01)
    ax.set_xticks([0, .25, .5, .75, 1]); ax.set_xticklabels(["0%", "25%", "50%", "75%", "100%"])
    ax.set_yticks([0, .25, .5, .75, 1]); ax.set_yticklabels(["0%", "25%", "50%", "75%", "100%"])
    ax.set_xlabel("False alarms: healthy reefs wrongly flagged", fontsize=12, color=t["ink2"], labelpad=10)
    ax.set_ylabel("Bleaching caught: bleached reefs flagged", fontsize=12, color=t["ink2"], labelpad=10)
    h, l = ax.get_legend_handles_labels()
    leg = ax.legend(h[::-1], l[::-1], loc="lower right", frameon=False, fontsize=11.5, title="Score (AUROC)", title_fontsize=10.5, labelcolor=t["ink"], handlelength=2.6)
    leg.get_title().set_color(t["ink2"])
    head(fig, t, "Coralytics catches more bleaching than NOAA's alert", f"{len(d):,} diver surveys from 2016 to 2020, years the model never saw. Bleached = 10% or more of coral.")
    foot(fig, t, "Higher and further left is better. Score: chance a bleached reef is ranked above a healthy one (1 = perfect, 0.5 = coin flip).")
    fig.savefig(f"{OUT}/roc-{name}.png", facecolor=t["bg"])
    plt.close(fig)

    fig = plt.figure(figsize=(10, 5.6), dpi=200, facecolor=t["bg"])
    ax = fig.add_axes([0.24, 0.17, 0.7, 0.56])
    style(ax, t)
    ax.grid(axis="y", visible=False)
    order = ["y_mod", "y30", "y_sev"]
    off = {"p": 0.22, "noaa_dhw_same_day": 0, "noaa_dhw_max90": -0.22}
    for k, target in enumerate(order):
        y0 = len(order) - 1 - k
        for col, c, fill in (("noaa_dhw_max90", t["noaa"], False), ("noaa_dhw_same_day", t["noaa"], True), ("p", t["ours"], True)):
            auc, (lo, hi) = stats[target][col]
            y = y0 + off[col]
            ax.plot([lo, hi], [y, y], color=c, lw=2, solid_capstyle="round")
            ax.scatter([auc], [y], s=80, color=c if fill else t["bg"], edgecolor=c, linewidth=2, zorder=4)
            if col == "p":
                ax.text(hi + 0.006, y, f"{auc:.3f}", va="center", fontsize=11, color=t["ink"], fontweight="semibold")
            else:
                ax.text(lo - 0.006, y, f"{auc:.3f}", va="center", ha="right", fontsize=10.5, color=t["ink2"])
        n = int(te[target][target].sum())
        ax.text(-0.02, y0, f"{LABELS[target]}\n{n} bleached surveys", transform=ax.get_yaxis_transform(), ha="right", va="center", fontsize=11.5, color=t["ink"], linespacing=1.4)
    ax.set_yticks([])
    ax.set_ylim(-0.6, len(order) - 0.4)
    ax.set_xlim(0.68, 1.0)
    ax.set_xlabel("Score (AUROC), with 95% range", fontsize=12, color=t["ink2"], labelpad=8)
    from matplotlib.lines import Line2D
    hand = [Line2D([], [], marker="o", ls="-", color=t["ours"], markersize=8, lw=2, label="Coralytics"), Line2D([], [], marker="o", ls="-", color=t["noaa"], markersize=8, lw=2, label="NOAA, survey day"), Line2D([], [], marker="o", ls="-", color=t["noaa"], markerfacecolor=t["bg"], markersize=8, lw=2, label="NOAA, 90-day peak")]
    ax.legend(handles=hand, loc="lower center", bbox_to_anchor=(0.5, 1.02), ncol=3, frameon=False, fontsize=11.5, labelcolor=t["ink"])
    head(fig, t, "Ahead of NOAA at every level of bleaching", "Same 2,771 unseen surveys, 2016 to 2020. Ranges from resampling reef sites 1,000 times.")
    fig.savefig(f"{OUT}/by-severity-{name}.png", facecolor=t["bg"])
    plt.close(fig)

    fig = plt.figure(figsize=(9, 5.8), dpi=200, facecolor=t["bg"])
    ax = fig.add_axes([0.08, 0.2, 0.88, 0.5])
    style(ax, t)
    ax.grid(axis="x", visible=False)
    ax.spines["left"].set_visible(False)
    ax.set_yticks([])
    groups = list(acc)
    w = 0.34
    for k, g in enumerate(groups):
        ours, noaa, n = acc[g]
        for dx, v, c, lab in ((-w / 2 - 0.01, 1 - ours, t["ours"], "Coralytics"), (w / 2 + 0.01, 1 - noaa, t["noaa"], "NOAA heat alert")):
            ax.bar(k + dx, v, w, color=c, label=lab if k == 0 else None)
            ax.text(k + dx, v + 0.006, f"{v:.0%}", ha="center", va="bottom", fontsize=16, fontweight="semibold", color=t["ink"])
    ax.set_xticks(range(len(groups)))
    ax.set_xticklabels([f"{g}\n{acc[g][2]:,} surveys" for g in groups], fontsize=11.5, color=t["ink2"], linespacing=1.4)
    ax.set_ylim(0, 0.3)
    ax.set_xlim(-0.6, 1.6)
    ax.legend(loc="lower center", bbox_to_anchor=(0.5, 1.04), ncol=2, frameon=False, fontsize=11.5, labelcolor=t["ink"])
    fewer = 1 - (1 - acc["2016 to 2020"][0]) / (1 - acc["2016 to 2020"][1])
    head(fig, t, "Fewer wrong calls than NOAA's alert", f"Share of diver surveys where the yes/no bleaching call was wrong. Lower is better. Since 2016: {fewer:.0%} fewer.")
    foot(fig, t, "Coralytics: model trained on other regions, 50% chance or more = yes. NOAA: 4 or more degree heating weeks = yes.")
    fig.savefig(f"{OUT}/wrong-calls-{name}.png", facecolor=t["bg"])
    plt.close(fig)

NAMES = {
    "pct": "Bleaching divers saw",
    "p": "Coralytics chance",
    "noaa_dhw_same_day": "NOAA alert, survey day",
    "noaa_dhw_max90": "NOAA alert, 90-day peak",
    "acc_12w_t0": "Heat built up, 12 weeks",
    "hs_max_30": "Hottest spell, 30 days",
    "nb_hsmax_mean": "Heat on nearby reefs",
    "days_above_90": "Hot days, last 90",
    "abs_lat": "Distance from equator",
    "seasonal_range": "Summer to winter swing",
    "prior_peak_dhw": "Heat in past 2 years",
    "depth": "Reef depth",
    "months_from_warmest": "Months from hottest month",
}
d = te["y_mod"]
corr = d[list(NAMES)].corr("spearman")
rest = corr["pct"].drop(["pct", "p", "noaa_dhw_same_day", "noaa_dhw_max90"]).sort_values(ascending=False).index.tolist()
order = ["pct", "p", "noaa_dhw_same_day", "noaa_dhw_max90"] + rest
corr = corr.loc[order, order]
print(corr["pct"].round(3).to_string())

from matplotlib.colors import LinearSegmentedColormap
from matplotlib.patches import Rectangle
for name, t in THEMES.items():
    plt.rcParams.update({"font.family": "Hanken Grotesk", "text.color": t["ink"]})
    mid = "#f0efec" if name == "light" else "#2a3a44"
    cmap = LinearSegmentedColormap.from_list("div", ["#e34948", mid, "#2a78d6"] if name == "light" else ["#e66767", mid, "#3987e5"])
    n = len(order)
    fig = plt.figure(figsize=(11, 11), dpi=200, facecolor=t["bg"])
    ax = fig.add_axes([0.27, 0.11, 0.6, 0.6])
    ax.set_facecolor(t["bg"])
    for i in range(n):
        for j in range(i):
            v = corr.iat[i, j]
            ax.add_patch(Rectangle((j + 0.04, n - 1 - i + 0.04), 0.92, 0.92, color=cmap((v + 1) / 2), lw=0))
            light_text = abs(v) > 0.55 and name == "light"
            ax.text(j + 0.5, n - 1 - i + 0.5, f"{v:.2f}".replace("0.", ".").replace("-.", "\u2212."), ha="center", va="center", fontsize=9.5, color="#ffffff" if light_text else t["ink"], fontweight="semibold" if j == 0 else "normal")
    ax.add_patch(Rectangle((0, 0), 1, n - 1, fill=False, ec=t["ink"], lw=1.6))
    ax.set_xlim(0, n - 1); ax.set_ylim(0, n - 1)
    ax.set_yticks([n - 1 - i + 0.5 for i in range(1, n)])
    ax.set_yticklabels([NAMES[c] for c in order[1:]], fontsize=11, color=t["ink"])
    ax.set_xticks([j + 0.5 for j in range(n - 1)])
    ax.set_xticklabels([NAMES[c] for c in order[:-1]], fontsize=10.5, color=t["ink2"], rotation=40, ha="left", rotation_mode="anchor")
    ax.xaxis.tick_top()
    ax.tick_params(length=0, pad=6)
    for s in ax.spines.values():
        s.set_visible(False)
    ax.get_yticklabels()[0].set_fontweight("semibold")
    cax = fig.add_axes([0.27, 0.06, 0.3, 0.012])
    sm = plt.cm.ScalarMappable(cmap=cmap, norm=plt.Normalize(-1, 1))
    cb = fig.colorbar(sm, cax=cax, orientation="horizontal", ticks=[-1, 0, 1])
    cb.outline.set_visible(False)
    cb.ax.set_xticklabels(["\u22121 opposite", "0 unrelated", "+1 together"], fontsize=9.5, color=t["ink2"])
    cb.ax.tick_params(length=0)
    head(fig, t, "Our prediction tracks real bleaching more closely than NOAA's alert", f"How strongly each pair rises and falls together across {len(d):,} unseen diver surveys, 2016 to 2020.")
    fig.text(0.62, 0.066, "Rank correlation (Spearman)", fontsize=9.5, color=t["ink2"], va="center")
    foot(fig, t, "Outlined column: each signal against the bleaching divers actually saw. Darker blue = rises and falls together more closely.")
    fig.savefig(f"{OUT}/correlation-{name}.png", facecolor=t["bg"])
    plt.close(fig)

    s = corr["pct"].drop("pct").sort_values(ascending=False)
    fig = plt.figure(figsize=(10, 7.2), dpi=200, facecolor=t["bg"])
    ax = fig.add_axes([0.3, 0.16, 0.62, 0.62])
    style(ax, t)
    ax.grid(axis="y", visible=False)
    ys = np.arange(len(s))[::-1]
    for y, (c, v) in zip(ys, s.items()):
        col = t["ours"] if c == "p" else t["noaa"] if c.startswith("noaa") else t["ref"]
        ax.barh(y, v, 0.62, color=col)
        ax.text(v + (0.008 if v >= 0 else -0.008), y, f"{v:.2f}".replace("-", "\u2212"), va="center", ha="left" if v >= 0 else "right", fontsize=11, color=t["ink"], fontweight="semibold" if c == "p" else "normal")
    ax.axvline(0, color=t["ink2"], lw=0.8)
    ax.set_yticks(ys)
    ax.set_yticklabels([NAMES[c] for c in s.index], fontsize=11.5, color=t["ink"])
    ax.set_xlim(-0.4, 0.62)
    ax.set_xlabel("Correlation with bleaching divers saw (Spearman)", fontsize=12, color=t["ink2"], labelpad=8)
    head(fig, t, "No single heat number explains bleaching as well as Coralytics", f"{len(d):,} unseen diver surveys, 2016 to 2020. Longer bar = rises and falls more closely with real bleaching.")
    foot(fig, t, "Coralytics combines all the grey signals, learned on other regions. NOAA's alert uses heat alone.")
    fig.savefig(f"{OUT}/drivers-{name}.png", facecolor=t["bg"])
    plt.close(fig)
print("done")
