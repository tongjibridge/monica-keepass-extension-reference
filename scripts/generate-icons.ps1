Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'public\icons'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function New-IconBitmap {
  param(
    [int]$Size,
    [string]$Path
  )

  $bmp = [System.Drawing.Bitmap]::new($Size, $Size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)

  $scale = $Size / 128.0
  $g.ScaleTransform($scale, $scale)

  $bg = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $radius = 28
  $bg.AddArc(0, 0, $radius * 2, $radius * 2, 180, 90)
  $bg.AddArc(128 - $radius * 2, 0, $radius * 2, $radius * 2, 270, 90)
  $bg.AddArc(128 - $radius * 2, 128 - $radius * 2, $radius * 2, $radius * 2, 0, 90)
  $bg.AddArc(0, 128 - $radius * 2, $radius * 2, $radius * 2, 90, 90)
  $bg.CloseFigure()

  $bgBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    [System.Drawing.RectangleF]::new(0, 0, 128, 128),
    [System.Drawing.Color]::FromArgb(37, 99, 235),
    [System.Drawing.Color]::FromArgb(15, 23, 42),
    45
  )
  $g.FillPath($bgBrush, $bg)

  $shield = [System.Drawing.Drawing2D.GraphicsPath]::new()
  [System.Drawing.PointF[]]$shieldPoints = @(
    [System.Drawing.PointF]::new(64, 23),
    [System.Drawing.PointF]::new(94, 35),
    [System.Drawing.PointF]::new(94, 59),
    [System.Drawing.PointF]::new(92, 72),
    [System.Drawing.PointF]::new(85, 86),
    [System.Drawing.PointF]::new(74, 98),
    [System.Drawing.PointF]::new(64, 105.5),
    [System.Drawing.PointF]::new(54, 98),
    [System.Drawing.PointF]::new(43, 86),
    [System.Drawing.PointF]::new(36, 72),
    [System.Drawing.PointF]::new(34, 59),
    [System.Drawing.PointF]::new(34, 35)
  )
  $shield.AddLines($shieldPoints)
  $shield.CloseFigure()
  $g.FillPath([System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(246, 249, 255)), $shield)

  $inner = [System.Drawing.Drawing2D.GraphicsPath]::new()
  [System.Drawing.PointF[]]$innerPoints = @(
    [System.Drawing.PointF]::new(64, 34),
    [System.Drawing.PointF]::new(84, 42),
    [System.Drawing.PointF]::new(84, 58),
    [System.Drawing.PointF]::new(82, 69),
    [System.Drawing.PointF]::new(76, 80),
    [System.Drawing.PointF]::new(64, 90.7),
    [System.Drawing.PointF]::new(52, 80),
    [System.Drawing.PointF]::new(46, 69),
    [System.Drawing.PointF]::new(44, 58),
    [System.Drawing.PointF]::new(44, 42)
  )
  $inner.AddLines($innerPoints)
  $inner.CloseFigure()
  $g.FillPath([System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(37, 99, 235)), $inner)

  $white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
  $g.FillEllipse($white, 56, 50, 16, 16)
  $lock = [System.Drawing.Drawing2D.GraphicsPath]::new()
  [System.Drawing.PointF[]]$lockPoints = @(
    [System.Drawing.PointF]::new(61, 64),
    [System.Drawing.PointF]::new(67, 64),
    [System.Drawing.PointF]::new(69, 82),
    [System.Drawing.PointF]::new(59, 82)
  )
  $lock.AddPolygon($lockPoints)
  $g.FillPath($white, $lock)

  $keyBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(103, 232, 249))
  $g.FillRectangle($keyBrush, 82, 82, 14, 7)
  $g.TranslateTransform(89, 82)
  $g.RotateTransform(-45)
  $g.FillRectangle($keyBrush, -2, -2, 24, 7)
  $g.ResetTransform()
  $g.ScaleTransform($scale, $scale)
  $g.FillRectangle($white, 98, 63, 11, 9)

  $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
}

foreach ($size in @(16, 32, 48, 128)) {
  New-IconBitmap -Size $size -Path (Join-Path $outDir "icon-$size.png")
}
