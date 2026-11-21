import modal
import reef_app as R

@R.app.function(image=R.cpu_image, timeout=600)
def orient():
    import io, datetime as dt, h5py, numpy as np, requests
    day = dt.date(2020, 1, 1)
    for label, url in [("sst", R.day_url("sst", day)), ("dhw", R.day_url("dhw", day)), ("clim", R.CLIM_URL)]:
        b = requests.get(url, timeout=600).content
        with h5py.File(io.BytesIO(b), "r") as f:
            lat = f["lat"][...]; lon = f["lon"][...]
            print(label, "lat first/last", float(lat[0]), float(lat[-1]), "lon first/last", float(lon[0]), float(lon[-1]))
