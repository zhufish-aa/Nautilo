package app.nautilo.mobile.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.nautilo.mobile.R
import app.nautilo.mobile.data.MobileTeamMember

@Composable internal fun TeamHarnessMark(member: MobileTeamMember, modifier: Modifier = Modifier) {
    val name = (member.providerId + " " + member.harness).lowercase()
    val drawable = when {
        "codex" in name || "openai" in name -> R.drawable.harness_codex
        "claude" in name -> R.drawable.harness_claude
        "deepseek" in name -> R.drawable.harness_deepseek
        else -> null
    }
    Box(modifier.size(27.dp).clip(RoundedCornerShape(8.dp)), contentAlignment = Alignment.Center) {
        if (drawable != null) Image(painterResource(drawable), null, Modifier.fillMaxSize(),
            colorFilter = ColorFilter.colorMatrix(ColorMatrix().apply { setToSaturation(0f) }))
        else Icon(Icons.Outlined.Terminal, null, Modifier.size(22.dp), tint = Ink)
    }
}

@Composable internal fun TeamMemberAvatar(member: MobileTeamMember, modifier: Modifier = Modifier) {
    // The avatar is the real member's identity, rather than a fixed decorative person.
    Box(modifier.size(28.dp).background(Color(0xFFEDEDEB), CircleShape).border(1.5.dp, TeamCanvas, CircleShape),
        contentAlignment = Alignment.Center) {
        Text(member.name.take(1).ifBlank { "A" }, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, color = Ink)
    }
}
