import os
import sys

try:
    from PIL import Image, ImageDraw, ImageFont, ImageFilter
except ImportError:
    print("Pillow is not installed. Please run: pip install Pillow")
    sys.exit(1)

input_dir = "photos"
output_dir = "store_assets"

os.makedirs(output_dir, exist_ok=True)

# Define configurations for each screenshot
configs = [
    {"file": "popup.png", "bg": "#0f172a"},       # Slate dark
    {"file": "manual.png", "bg": "#f8fafc"},      # Very light slate/blue
    {"file": "vault.png", "bg": "#f3e8ff"},       # Light purple
    {"file": "auto-fill.png", "bg": "#ecfdf5"}    # Light emerald
]

canvas_w, canvas_h = 1280, 800

def add_shadow(img):
    """Add a simple drop shadow to the image."""
    shadow = Image.new("RGBA", img.size, (0, 0, 0, 80))
    # Blur the shadow
    shadow = shadow.filter(ImageFilter.GaussianBlur(10))
    # Offset shadow
    shadow_offset = (0, 10)
    shadow_canvas = Image.new("RGBA", (img.width + 40, img.height + 40), (0,0,0,0))
    shadow_canvas.paste(shadow, (20 + shadow_offset[0], 20 + shadow_offset[1]))
    shadow_canvas.paste(img, (20, 20), img)
    return shadow_canvas

for c in configs:
    in_path = os.path.join(input_dir, c["file"])
    out_path = os.path.join(output_dir, c["file"])
    if not os.path.exists(in_path):
        print(f"Skipping {in_path} - not found")
        continue
    
    # Create background canvas
    bg = Image.new('RGB', (canvas_w, canvas_h), c["bg"])
    
    # Open raw image
    img = Image.open(in_path).convert("RGBA")
    
    # Resize keeping aspect ratio so it fits nicely in 1280x800
    img.thumbnail((1050, 700), Image.Resampling.LANCZOS)
    
    # Optional: add shadow if you want a floating effect
    img = add_shadow(img)
    
    # Center paste
    x = (canvas_w - img.width) // 2
    y = (canvas_h - img.height) // 2
    
    # Paste using alpha channel as mask to keep shadow and transparency
    bg.paste(img, (x, y), img)
    
    bg.save(out_path, format="PNG")
    print(f"✅ Generated {out_path}")

# --- Generate Promotional Tile (440x280) ---
print("\nGenerating Promotional Tile...")
tile = Image.new('RGB', (440, 280), "#0f172a") # Dark background
draw = ImageDraw.Draw(tile)

try:
    font_large = ImageFont.truetype("arialbd.ttf", 46)
    font_small = ImageFont.truetype("arial.ttf", 22)
except IOError:
    font_large = ImageFont.load_default()
    font_small = ImageFont.load_default()

text = "SmartFill"
sub = "AI Form Automation"

# Calculate text width to center it
try:
    bbox_large = font_large.getbbox(text)
    tw = bbox_large[2] - bbox_large[0]
except AttributeError:
    # Fallback for older PIL
    tw, _ = draw.textsize(text, font=font_large)

try:
    bbox_small = font_small.getbbox(sub)
    sw = bbox_small[2] - bbox_small[0]
except AttributeError:
    sw, _ = draw.textsize(sub, font=font_small)

# Draw text centered
draw.text(((440 - tw)//2, 100), text, fill="#ffffff", font=font_large)
draw.text(((440 - sw)//2, 160), sub, fill="#94a3b8", font=font_small)

tile_path = os.path.join(output_dir, "promo_tile.png")
tile.save(tile_path, format="PNG")
print(f"✅ Generated {tile_path}")

print("\n🎉 All store assets created successfully in the 'store_assets' folder!")
